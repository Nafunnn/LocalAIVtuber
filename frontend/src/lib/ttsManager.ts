import { pipelineManager } from './pipelineManager';
import { globalStateManager } from './globalStateManager';
import { BaseTTSProvider } from './tts/baseTTSProvider';
import { GPTSoVITSProvider } from './tts/gptsovitsProvider';
import { RVCProvider } from './tts/rvcProvider';
import { detectFillerMood, fetchFillerAudio } from './ttsFiller';

type TTSProvider = "gpt-sovits" | "rvc";
type TTSUpdateCallback = () => void;

const FILLER_STOP_GAP_MS = 80;

export class TTSManager {
    private abortController: AbortController | null = null;
    private currentAudio: HTMLAudioElement | null = null;
    private isProcessing: boolean = false;
    private isPlaying: boolean = false;
    private isFillerPlaying: boolean = false;
    private fillerSession: number = 0;
    private audioContext: AudioContext | null = null;
    private fillerAudio: HTMLAudioElement | null = null;
    private selectedProvider: TTSProvider;
    private subscribers: Set<TTSUpdateCallback> = new Set();
    private providers: Record<TTSProvider, BaseTTSProvider>;

    constructor() {
        this.selectedProvider = "gpt-sovits";
        this.providers = {
            "gpt-sovits": new GPTSoVITSProvider(),
            "rvc": new RVCProvider()
        };
        this.setupPipelineSubscription();
    }

    public subscribe(callback: TTSUpdateCallback): () => void {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    private notifySubscribers() {
        this.subscribers.forEach(callback => callback());
    }

    public getSelectedProvider(): TTSProvider {
        return this.selectedProvider;
    }

    public setSelectedProvider(provider: TTSProvider) {
        this.selectedProvider = provider;
        this.notifySubscribers();
    }

    public getCurrentProviderInstance(): BaseTTSProvider {
        return this.providers[this.selectedProvider];
    }

    private setupPipelineSubscription() {
        return pipelineManager.subscribe(() => {
            this.processNextTTS();
            this.processNextAudio();
        });
    }

    private getAudioContext(): AudioContext {
        if (!this.audioContext) {
            this.audioContext = new AudioContext();
        }
        return this.audioContext;
    }

    private resetLiveVolume() {
        globalStateManager.updateState("ttsLiveVolume", 0);
    }

    private analyzeAudio(audio: HTMLAudioElement, isFiller = false) {
        try {
            const audioContext = this.getAudioContext();
            if (audioContext.state === "suspended") {
                void audioContext.resume();
            }
            const source = audioContext.createMediaElementSource(audio);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            source.connect(analyser);
            analyser.connect(audioContext.destination);

            const updateVolume = () => {
                if (isFiller && !this.isFillerPlaying) return;
                if (!isFiller && this.currentAudio !== audio) return;

                analyser.getByteFrequencyData(dataArray);
                const avgVolume = dataArray.reduce((a, b) => a + b, 0);
                const normalizedVolume = avgVolume / 15096;
                globalStateManager.updateState("ttsLiveVolume", normalizedVolume);
                if (!audio.paused) {
                    requestAnimationFrame(updateVolume);
                }
            };

            updateVolume();
        } catch (err) {
            console.warn("Audio analysis unavailable:", err);
        }
    }

    private async stopFillerAndWait(): Promise<void> {
        if (!this.fillerAudio) {
            this.isFillerPlaying = false;
            this.resetLiveVolume();
            return;
        }

        const audio = this.fillerAudio;
        audio.loop = false;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.currentTime = 0;

        if (audio.src.startsWith("blob:")) {
            URL.revokeObjectURL(audio.src);
        }

        this.fillerAudio = null;
        this.isFillerPlaying = false;
        this.resetLiveVolume();

        await new Promise((resolve) => setTimeout(resolve, FILLER_STOP_GAP_MS));
    }

    private invalidateFillerSession() {
        this.fillerSession += 1;
    }

    private async playFillerWhileProcessing(
        session: number,
        textToSpeak: string,
        userInput?: string
    ) {
        const fillerUrl = await fetchFillerAudio(
            detectFillerMood(textToSpeak, userInput ?? ""),
            textToSpeak,
            userInput ?? ""
        );

        if (!fillerUrl || session !== this.fillerSession || !this.isProcessing) {
            if (fillerUrl?.startsWith("blob:")) {
                URL.revokeObjectURL(fillerUrl);
            }
            return;
        }

        await this.stopFillerAndWait();
        if (session !== this.fillerSession || !this.isProcessing) return;

        const audio = new Audio(fillerUrl);
        audio.loop = false;
        this.fillerAudio = audio;
        this.isFillerPlaying = true;

        const clearFiller = () => {
            if (this.fillerAudio !== audio) return;
            this.fillerAudio = null;
            this.isFillerPlaying = false;
            this.resetLiveVolume();
        };

        audio.onended = clearFiller;
        audio.onerror = clearFiller;

        try {
            await audio.play();
            if (session !== this.fillerSession || !this.isProcessing) {
                await this.stopFillerAndWait();
                return;
            }
            this.analyzeAudio(audio, true);
        } catch (err) {
            console.warn("Filler playback skipped:", err);
            clearFiller();
            if (audio.src.startsWith("blob:")) {
                URL.revokeObjectURL(audio.src);
            }
        }
    }

    public async generateAudioFromText(text: string): Promise<string> {
        const abortController = new AbortController();
        this.abortController = abortController;

        const provider = this.getCurrentProviderInstance();
        const response = await provider.generateAudio(text);
        const blob = await response.blob();
        return URL.createObjectURL(blob);
    }

    private async processNextTTS() {
        const currentTask = pipelineManager.getCurrentTask();
        if (currentTask?.status == "pending_interruption" && !currentTask.interruptionState?.tts) {
            if (this.abortController) {
                this.abortController.abort();
            }
            this.invalidateFillerSession();
            await this.stopFillerAndWait();
            this.isProcessing = false;
            pipelineManager.markInterruptionState("tts");
            return;
        }

        if (this.isProcessing) return;

        const next = pipelineManager.getNextTaskForTTS();
        if (!next) return;

        const { taskId, responseIndex, task } = next;
        const textToSpeak = task.response[responseIndex].text;

        this.isProcessing = true;
        const session = this.fillerSession;
        void this.playFillerWhileProcessing(session, textToSpeak, task.input);

        try {
            const audioUrl = await this.generateAudioFromText(textToSpeak);

            this.invalidateFillerSession();
            await this.stopFillerAndWait();

            this.isProcessing = false;
            pipelineManager.addTTSAudio(taskId, responseIndex, audioUrl);
        } catch (err) {
            console.error("TTS pipeline error:", err);
            this.invalidateFillerSession();
            await this.stopFillerAndWait();
            this.isProcessing = false;
            pipelineManager.markTTSFailed(taskId, responseIndex);
        }
    }

    private finishPlayback(taskId: string, responseIndex: number) {
        this.isPlaying = false;
        this.currentAudio = null;
        this.resetLiveVolume();
        pipelineManager.markPlaybackFinished(taskId, responseIndex);
    }

    private async processNextAudio() {
        const currentTask = pipelineManager.getCurrentTask();
        if (currentTask?.status == "pending_interruption" && !currentTask.interruptionState?.audio) {
            if (this.currentAudio) {
                this.currentAudio.pause();
                this.currentAudio.currentTime = 0;
                this.currentAudio = null;
            }
            this.invalidateFillerSession();
            await this.stopFillerAndWait();
            this.isPlaying = false;
            pipelineManager.markInterruptionState("audio");
            return;
        }

        if (this.isPlaying || this.isFillerPlaying) return;

        const next = pipelineManager.getNextTaskForAudio();
        if (!next) return;

        const { taskId, responseIndex, task } = next;
        const audioUrl = task.response[responseIndex].audio;

        await this.stopFillerAndWait();

        this.isPlaying = true;

        const audio = new Audio(audioUrl!);
        this.currentAudio = audio;

        audio.onended = () => {
            this.finishPlayback(taskId, responseIndex);
        };

        audio.onerror = () => {
            console.error("Audio playback error");
            this.finishPlayback(taskId, responseIndex);
        };

        try {
            await audio.play();
            this.analyzeAudio(audio, false);
        } catch (err) {
            console.error("Audio play failed:", err);
            this.finishPlayback(taskId, responseIndex);
        }
    }
}

export const ttsManager = new TTSManager();
