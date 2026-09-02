import { voiceInputManager } from "./voiceInputManager";

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
};

class PushToTalkController {
  private holding = false;
  private enabled = true;
  private bound = false;

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    if (this.holding) {
      this.holding = false;
      void voiceInputManager.stopRecording();
    }
  }

  isHolding() {
    return this.holding;
  }

  bind() {
    if (this.bound || typeof window === "undefined") return;
    this.bound = true;

    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  unbind() {
    if (!this.bound) return;
    this.bound = false;
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.holding) {
      this.holding = false;
      void voiceInputManager.stopRecording();
    }
  }

  private isPushToTalkChord(event: KeyboardEvent): boolean {
    const isSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
    return isSpace && (event.ctrlKey || event.metaKey) && !event.altKey;
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.enabled || !this.isPushToTalkChord(event)) return;
    // Allow PTT even in inputs; prevent typing a space while held.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || this.holding) return;

    this.holding = true;
    void voiceInputManager.startRecording({ batchUntilStop: true });
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (!this.holding) return;

    const releasedSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
    const releasedCtrl = event.key === "Control" || event.key === "Meta";
    if (!releasedSpace && !releasedCtrl) return;

    event.preventDefault();
    event.stopPropagation();
    this.holding = false;
    void voiceInputManager.stopRecording();
  };

  private onBlur = () => {
    if (!this.holding) return;
    this.holding = false;
    void voiceInputManager.stopRecording();
  };

  private onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && this.holding) {
      this.holding = false;
      void voiceInputManager.stopRecording();
    }
  };
}

export const pushToTalkController = new PushToTalkController();

// Ensure editable check is available if we later want soft-disable in forms.
export { isEditableTarget };
