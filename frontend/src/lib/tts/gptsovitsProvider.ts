import { BaseTTSProvider } from "./baseTTSProvider";

export interface TTSVoice {
    name: string;
    displayName?: string;
}

type GPTSoVITSStateUpdateCallback = () => void;

export class GPTSoVITSProvider extends BaseTTSProvider {
    private currentVoice: string | null = null;
    private voices: TTSVoice[] = [];
    private subscribers = new Set<GPTSoVITSStateUpdateCallback>();

    constructor() {
        super();
        this.initialize();
    }

    private async initialize() {
        await this.fetchVoices();
    }

    // Add public method to refresh voices
    async refreshVoices(): Promise<void> {
        await this.fetchVoices();
    }

    subscribe(callback: GPTSoVITSStateUpdateCallback): () => void {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    private notifySubscribers() {
        this.subscribers.forEach(callback => callback());
    }

    private async fetchVoices() {
        try {
            const response = await fetch('/api/tts/voices');
            const data = await response.json();
            if (!response.ok) {
                this.voices = [];
                return;
            }
            const rawVoices = Array.isArray(data.voices) ? data.voices : [];
            this.voices = rawVoices.map((voice: string | TTSVoice) =>
                typeof voice === "string" ? { name: voice } : voice
            );
            if (!this.currentVoice && this.voices[0]?.name) {
                await this.setVoice(this.voices[0].name);
            }
            this.notifySubscribers();
        } catch (error) {
            console.error("Failed to fetch TTS voices:", error);
            this.voices = [];
            this.notifySubscribers();
        }
    }

    getVoices(): TTSVoice[] {
        return this.voices;
    }

    getCurrentVoice(): string | null {
        return this.currentVoice;
    }

    async setVoice(voice: string): Promise<void> {
        if (!voice) {
            return;
        }
        const response = await fetch('/api/tts/change-voice', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ voice_name: voice })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to change voice');
        }

        this.currentVoice = voice;
        this.notifySubscribers();
    }

    async generateAudio(text: string): Promise<Response> {
        const response = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text })
        });

        if (!response.ok) {
            throw new Error("GPT-SoVITS generation failed");
        }

        return response;
    }
}