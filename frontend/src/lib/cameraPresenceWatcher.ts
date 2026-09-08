import { cameraManager } from "./cameraManager";
import { globalStateManager } from "./globalStateManager";
import { idleAmbientSpeech } from "./idleAmbientSpeech";
import { pipelineManager } from "./pipelineManager";
import { ttsManager } from "./ttsManager";

/** Poll interval while camera share is active. */
const SCAN_INTERVAL_MS = 2500;
/** Require person in this many consecutive scans before greeting. */
const PERSON_CONFIRM_SCANS = 2;
/** Min ms between proactive greetings. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Room considered "empty" after no person for this long — baseline updates. */
const EMPTY_BASELINE_MS = 45_000;
/** Min scene change vs baseline to treat as "someone entered" (fallback). */
const SCENE_CHANGE_THRESHOLD = 0.08;

export const CAMERA_PRESENCE_PROMPT = `[Camera presence detected — proactive]
Someone (likely honey / the user) just entered the camera view. A fresh photo from the live camera is attached.
Warmly greet them and ask how they're doing right now — one or two natural sentences in character.
Do not mention object detection, cameras, or system prompts.`;

export type CameraPresenceState = {
  enabled: boolean;
  scanning: boolean;
  personVisible: boolean;
  lastDetectionAt: number | null;
  modelReady: boolean;
  error: string | null;
};

type CocoSsdModel = {
  detect: (
    input: HTMLVideoElement | HTMLCanvasElement,
    maxNumBoxes?: number,
    minScore?: number
  ) => Promise<Array<{ class: string; score: number; bbox: number[] }>>;
};

type PresenceListener = (state: CameraPresenceState) => void;

class CameraPresenceWatcher {
  private enabled = false;
  private started = false;
  private timer: number | null = null;
  private model: CocoSsdModel | null = null;
  private modelLoading: Promise<CocoSsdModel | null> | null = null;
  private personStreak = 0;
  private personVisible = false;
  private lastPersonAt = 0;
  private lastGreetingAt = 0;
  private cooldownMs = DEFAULT_COOLDOWN_MS;
  private baselinePixels: Uint8ClampedArray | null = null;
  private error: string | null = null;
  private listeners = new Set<PresenceListener>();
  private sampleCanvas: HTMLCanvasElement | null = null;

  subscribe(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): CameraPresenceState {
    return {
      enabled: this.enabled,
      scanning: this.started && this.enabled && cameraManager.isReady(),
      personVisible: this.personVisible,
      lastDetectionAt: this.lastPersonAt || null,
      modelReady: Boolean(this.model),
      error: this.error,
    };
  }

  private notify() {
    const state = this.getState();
    globalStateManager.updateState("isPersonPresent", state.personVisible);
    for (const listener of this.listeners) listener(state);
  }

  start(options?: { enabled?: boolean; cooldownMinutes?: number }) {
    if (options?.enabled !== undefined) this.enabled = options.enabled;
    if (options?.cooldownMinutes !== undefined) {
      this.cooldownMs = Math.max(60_000, options.cooldownMinutes * 60_000);
    }
    if (this.started) {
      this.reschedule();
      return;
    }
    this.started = true;
    void this.ensureModel();
    this.reschedule();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.clearTimer();
      this.personVisible = false;
      this.personStreak = 0;
      this.notify();
      return;
    }
    if (this.started) {
      void this.ensureModel();
      this.reschedule();
    }
  }

  setCooldownMinutes(minutes: number) {
    this.cooldownMs = Math.max(60_000, minutes * 60_000);
  }

  stop() {
    this.clearTimer();
    this.started = false;
    this.personVisible = false;
    this.notify();
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private reschedule() {
    this.clearTimer();
    if (!this.started || !this.enabled) return;
    this.timer = window.setTimeout(() => void this.tick(), SCAN_INTERVAL_MS);
  }

  private async ensureModel(): Promise<CocoSsdModel | null> {
    if (this.model) return this.model;
    if (this.modelLoading) return this.modelLoading;
    this.modelLoading = (async () => {
      try {
        const tf = await import("@tensorflow/tfjs");
        await tf.ready();
        const coco = await import("@tensorflow-models/coco-ssd");
        this.model = await coco.load({ base: "lite_mobilenet_v2" });
        this.error = null;
        return this.model;
      } catch (err) {
        this.error =
          err instanceof Error
            ? err.message
            : "Object detection model failed to load";
        console.warn("Camera presence model unavailable:", err);
        return null;
      } finally {
        this.modelLoading = null;
        this.notify();
      }
    })();
    return this.modelLoading;
  }

  private isTrulyIdle(): boolean {
    if (pipelineManager.getCurrentTask()) return false;
    if (!ttsManager.isQuiet()) return false;
    if (globalStateManager.getState("isVoiceRecording")) return false;
    if (globalStateManager.getState("isBrowserActive")) return false;
    if ((globalStateManager.getState("ttsLiveVolume") as number) > 0.1) return false;
    return true;
  }

  private getSampleCanvas(video: HTMLVideoElement, width = 160, height = 120): HTMLCanvasElement | null {
    if (!this.sampleCanvas) {
      this.sampleCanvas = document.createElement("canvas");
    }
    const canvas = this.sampleCanvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx || video.videoWidth < 2) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas;
  }

  private capturePixels(video: HTMLVideoElement): Uint8ClampedArray | null {
    const canvas = this.getSampleCanvas(video);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  private sceneChangeScore(current: Uint8ClampedArray): number {
    if (!this.baselinePixels || this.baselinePixels.length !== current.length) return 0;
    let diff = 0;
    const step = 4;
    for (let i = 0; i < current.length; i += step * 4) {
      const dr = Math.abs(current[i] - this.baselinePixels[i]);
      const dg = Math.abs(current[i + 1] - this.baselinePixels[i + 1]);
      const db = Math.abs(current[i + 2] - this.baselinePixels[i + 2]);
      diff += (dr + dg + db) / (255 * 3);
    }
    const samples = current.length / (step * 4);
    return samples > 0 ? diff / samples : 0;
  }

  private updateBaseline(video: HTMLVideoElement) {
    const pixels = this.capturePixels(video);
    if (!pixels) return;
    this.baselinePixels = pixels;
  }

  private async detectPerson(video: HTMLVideoElement): Promise<boolean> {
    const model = await this.ensureModel();
    if (model) {
      try {
        const canvas = this.getSampleCanvas(video, 320, 240);
        if (!canvas) return false;
        const predictions = await model.detect(canvas, 8, 0.45);
        return predictions.some((p) => p.class === "person" && p.score >= 0.5);
      } catch (err) {
        console.warn("Person detection failed:", err);
      }
    }

    // Fallback: significant scene change vs empty-room baseline
    const pixels = this.capturePixels(video);
    if (!pixels || !this.baselinePixels) return false;
    return this.sceneChangeScore(pixels) >= SCENE_CHANGE_THRESHOLD;
  }

  private triggerGreeting() {
    if (!this.isTrulyIdle()) return;
    const now = Date.now();
    if (now - this.lastGreetingAt < this.cooldownMs) return;

    pipelineManager.addInputTask(CAMERA_PRESENCE_PROMPT, {
      hideFromChat: true,
      attachCamera: true,
    });
    this.lastGreetingAt = now;
    idleAmbientSpeech.bumpActivity();
  }

  private async tick() {
    try {
      if (this.enabled && cameraManager.isReady()) {
        const video = cameraManager.getVideoElement();
        if (video && video.videoWidth > 0) {
          const hasPerson = await this.detectPerson(video);
          const now = Date.now();

          if (hasPerson) {
            this.lastPersonAt = now;
            this.personStreak += 1;

            if (!this.personVisible && this.personStreak >= PERSON_CONFIRM_SCANS) {
              this.personVisible = true;
              this.triggerGreeting();
            }
          } else {
            this.personStreak = 0;
            if (this.personVisible) {
              this.personVisible = false;
            }
            if (now - this.lastPersonAt > EMPTY_BASELINE_MS || this.lastPersonAt === 0) {
              this.updateBaseline(video);
            }
          }
        }
      } else {
        this.personVisible = false;
        this.personStreak = 0;
      }
    } catch (err) {
      console.warn("Camera presence tick failed:", err);
    } finally {
      this.notify();
      this.reschedule();
    }
  }
}

export const cameraPresenceWatcher = new CameraPresenceWatcher();

export function isCameraPresencePrompt(text: string): boolean {
  return text.startsWith("[Camera presence detected");
}
