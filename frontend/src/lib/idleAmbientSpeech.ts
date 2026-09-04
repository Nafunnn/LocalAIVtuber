import { globalStateManager } from "./globalStateManager";
import { pipelineManager } from "./pipelineManager";
import { ttsManager } from "./ttsManager";

/** Wait at least this long after any activity before an idle line is allowed. */
const QUIET_BEFORE_SPEAK_MS = 25_000;
/** Random delay between idle checks. */
const IDLE_MIN_MS = 45_000;
const IDLE_MAX_MS = 2.5 * 60_000;
/** Chance to actually speak when a check fires while quiet. */
const SPEAK_CHANCE = 0.55;

type IdleSpeechOptions = {
  enabled?: boolean;
};

/**
 * Rare spontaneous humming / soft call-outs while the AI is otherwise idle.
 * Frontend-owned so it can respect TTS, voice recording, and pipeline state.
 */
class IdleAmbientSpeech {
  private enabled = false;
  private started = false;
  private timer: number | null = null;
  private lastActivityAt = Date.now();
  private unsubscribers: Array<() => void> = [];

  start(options: IdleSpeechOptions = {}) {
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    }
    if (this.started) {
      this.reschedule();
      return;
    }
    this.started = true;
    this.bumpActivity();
    this.unsubscribers.push(
      pipelineManager.subscribe(() => {
        if (pipelineManager.getCurrentTask()) {
          this.bumpActivity();
        }
      })
    );
    this.unsubscribers.push(
      globalStateManager.subscribe("isVoiceRecording", (recording) => {
        if (recording) this.bumpActivity();
      })
    );
    this.unsubscribers.push(
      globalStateManager.subscribe("ttsLiveVolume", (volume) => {
        if (typeof volume === "number" && volume > 0.12) {
          this.bumpActivity();
        }
      })
    );
    this.reschedule();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.clearTimer();
      return;
    }
    if (this.started) {
      this.reschedule();
    }
  }

  stop() {
    this.clearTimer();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.started = false;
  }

  bumpActivity() {
    this.lastActivityAt = Date.now();
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private nextDelayMs() {
    return IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS);
  }

  private reschedule() {
    this.clearTimer();
    if (!this.enabled || !this.started) return;
    this.timer = window.setTimeout(() => {
      void this.tick();
    }, this.nextDelayMs());
  }

  private isTrulyIdle(): boolean {
    if (pipelineManager.getCurrentTask()) return false;
    if (!ttsManager.isQuiet()) return false;
    if (globalStateManager.getState("isVoiceRecording")) return false;
    if (globalStateManager.getState("isBrowserActive")) return false;
    if ((globalStateManager.getState("ttsLiveVolume") as number) > 0.1) return false;
    if (Date.now() - this.lastActivityAt < QUIET_BEFORE_SPEAK_MS) return false;
    return true;
  }

  private async tick() {
    try {
      if (
        this.enabled &&
        this.isTrulyIdle() &&
        Math.random() < SPEAK_CHANCE
      ) {
        const played = await ttsManager.playIdleAmbient();
        if (played) {
          this.bumpActivity();
        }
      }
    } catch (err) {
      console.warn("Idle ambient speech failed:", err);
    } finally {
      this.reschedule();
    }
  }
}

export const idleAmbientSpeech = new IdleAmbientSpeech();
