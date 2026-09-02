import { pipelineManager } from "./pipelineManager";
import { globalStateManager } from "./globalStateManager";

type VoiceInputListener = (state: VoiceInputState) => void;

export interface VoiceInputState {
  connected: boolean;
  recording: boolean;
  probability: number;
  lastTranscription: string | null;
  error: string | null;
  status: string | null;
}

class VoiceInputManager {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;
  private recording = false;
  private starting = false;
  private stopping = false;
  private probability = 0;
  private lastTranscription: string | null = null;
  private error: string | null = null;
  private status: string | null = null;
  private connected = false;
  private listeners = new Set<VoiceInputListener>();
  private transcriptions: string[] = [];

  constructor() {
    if (typeof window !== "undefined") {
      this.connect();
    }
  }

  subscribe(listener: VoiceInputListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): VoiceInputState {
    return {
      connected: this.connected,
      recording: this.recording,
      probability: this.probability,
      lastTranscription: this.lastTranscription,
      error: this.error,
      status: this.status,
    };
  }

  getTranscriptions(): string[] {
    return [...this.transcriptions];
  }

  private notify() {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private setStatus(status: string | null) {
    this.status = status;
    this.notify();
  }

  private setError(error: string | null) {
    this.error = error;
    this.notify();
  }

  private connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/audio`);
    this.socket = socket;

    socket.onopen = () => {
      this.connected = true;
      this.setStatus("Voice service connected");
      this.setError(null);
    };

    socket.onclose = () => {
      this.connected = false;
      this.socket = null;
      this.setStatus("Voice service disconnected");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      this.setError("Voice WebSocket connection failed");
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "probability") {
          this.probability = Number(data.probability) || 0;
          if (
            this.probability >= 0.3 &&
            pipelineManager.getCurrentTask()?.status !== "pending_interruption"
          ) {
            pipelineManager.interruptCurrentTask();
          }
          this.notify();
        } else if (data.type === "transcription") {
          const text = String(data.text || "").trim();
          if (!text) return;
          this.lastTranscription = text;
          this.transcriptions.push(text);
          this.setStatus("Transcription received");
          this.setError(null);
          pipelineManager.addInputTask(text);
          this.notify();
        } else if (data.type === "error") {
          this.setError(data.message || "Voice input error");
        }
      } catch (err) {
        console.error("Failed to parse voice websocket message:", err);
      }
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  async startRecording(options: { batchUntilStop?: boolean } = {}): Promise<boolean> {
    if (this.recording || this.starting) return this.recording;
    this.starting = true;
    this.setError(null);
    this.setStatus("Starting voice input...");
    this.connect();

    const batchUntilStop = options.batchUntilStop ?? false;

    try {
      const response = await fetch("/api/record/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_until_stop: batchUntilStop }),
      });
      if (!response.ok) {
        this.setError("Failed to start voice recording");
        return false;
      }
      this.recording = true;
      this.probability = 0;
      globalStateManager.updateState("isVoiceRecording", true);
      this.setStatus(
        batchUntilStop
          ? "Listening... release Ctrl+Space to send full message"
          : "Listening... speak, then stop or pause to transcribe"
      );
      return true;
    } catch (err) {
      this.setError(err instanceof Error ? err.message : "Failed to start recording");
      return false;
    } finally {
      this.starting = false;
      this.notify();
    }
  }

  async stopRecording(): Promise<void> {
    if ((!this.recording && !this.starting) || this.stopping) return;
    this.stopping = true;
    this.setStatus("Stopping and transcribing...");

    try {
      const response = await fetch("/api/record/stop", { method: "POST" });
      if (!response.ok) {
        this.setError("Failed to stop voice recording");
      }
    } catch (err) {
      this.setError(err instanceof Error ? err.message : "Failed to stop recording");
    } finally {
      this.recording = false;
      this.probability = 0;
      globalStateManager.updateState("isVoiceRecording", false);
      this.stopping = false;
      this.setStatus("Released. Transcription will appear if speech was detected.");
      this.notify();
    }
  }

  destroy() {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.stopRecording();
    this.socket?.close();
    this.socket = null;
  }
}

export const voiceInputManager = new VoiceInputManager();
