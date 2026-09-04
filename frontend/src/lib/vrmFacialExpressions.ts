import type { VRM } from "@pixiv/three-vrm";

/** Standard VRM preset expression names we drive from AI mood. */
export type VrmFacePreset =
  | "happy"
  | "angry"
  | "sad"
  | "surprised"
  | "relaxed";

export type FaceEmotion =
  | "neutral"
  | "happy"
  | "sad"
  | "angry"
  | "surprised"
  | "thinking"
  | "listen"
  | "affectionate"
  | "playful";

const EMOTION_WEIGHTS: Record<FaceEmotion, Partial<Record<VrmFacePreset, number>>> = {
  neutral: {},
  happy: { happy: 0.85 },
  sad: { sad: 0.8 },
  angry: { angry: 0.75 },
  surprised: { surprised: 0.9 },
  thinking: { relaxed: 0.55 },
  listen: { relaxed: 0.4 },
  affectionate: { happy: 0.7 },
  playful: { happy: 0.65 },
};

const ALL_PRESETS: VrmFacePreset[] = [
  "happy",
  "angry",
  "sad",
  "surprised",
  "relaxed",
];

const FACE_KEYWORD_RULES: Array<{ emotion: FaceEmotion; re: RegExp }> = [
  {
    emotion: "angry",
    re: /\b(angry|mad|annoyed|furious|jealous|hate)\b|marah|kesal|jengkel/i,
  },
  {
    emotion: "sad",
    re: /\b(sad|cry|tears?|lonely|sorry|miss you|hurt|upset|depressed)\b|sedih|menangis|kangen|maaf/i,
  },
  {
    emotion: "surprised",
    re: /\b(wow|whoa|surprised|shock(ed)?|omg|really\?|no way)\b|kaget|terkejut|wah+/i,
  },
  {
    emotion: "playful",
    re: /\b(hehe|haha|lol|teehee|naughty|silly|tease|joke)\b|hehe|wkwk|lucu|godain/i,
  },
  {
    emotion: "affectionate",
    re: /\b(love|kiss|hug|honey|dear|darling|sweetheart|miss you)\b|sayang|cinta|cium|peluk/i,
  },
  {
    emotion: "happy",
    re: /\b(happy|glad|yay|great|awesome|excited|smile|fun|good)\b|senang|bahagia|gembira|senyum/i,
  },
  {
    emotion: "thinking",
    re: /\b(think|thinking|hmm+|wonder|maybe|consider|not sure)\b|pikir|mungkin|hmm+/i,
  },
];

export function detectFaceEmotion(text: string, userText = ""): FaceEmotion {
  const combined = `${text}\n${userText}`.trim();
  if (!combined) return "neutral";
  for (const rule of FACE_KEYWORD_RULES) {
    if (rule.re.test(combined)) return rule.emotion;
  }
  return "neutral";
}

export class VrmFacialController {
  private vrm: VRM | null = null;
  private current: Record<VrmFacePreset, number> = {
    happy: 0,
    angry: 0,
    sad: 0,
    surprised: 0,
    relaxed: 0,
  };
  private target: Record<VrmFacePreset, number> = { ...this.current };
  private emotion: FaceEmotion = "neutral";
  private holdUntil = 0;
  private available = new Set<string>();

  attach(vrm: VRM | null) {
    this.vrm = vrm;
    this.available.clear();
    if (!vrm?.expressionManager) return;

    for (const name of ALL_PRESETS) {
      // Probe: set 0 — if expression missing, three-vrm typically no-ops
      try {
        const track = vrm.expressionManager.getExpressionTrackName(name);
        if (track) this.available.add(name);
        else {
          // Some models expose via getExpression
          const expr = vrm.expressionManager.getExpression(name);
          if (expr) this.available.add(name);
        }
      } catch {
        // ignore missing
      }
    }

    // Fallback: try setting known presets even if track name lookup failed
    if (this.available.size === 0) {
      for (const name of ALL_PRESETS) this.available.add(name);
    }
  }

  getEmotion() {
    return this.emotion;
  }

  /**
   * Set facial emotion. `holdMs` keeps it from being overwritten by weaker cues.
   */
  setEmotion(emotion: FaceEmotion, holdMs = 3500, force = false) {
    const now = Date.now();
    if (!force && now < this.holdUntil && emotion === "neutral") return;
    if (!force && now < this.holdUntil && this.priority(emotion) < this.priority(this.emotion)) {
      return;
    }

    this.emotion = emotion;
    this.holdUntil = now + holdMs;

    const weights = EMOTION_WEIGHTS[emotion] ?? {};
    for (const name of ALL_PRESETS) {
      this.target[name] = weights[name] ?? 0;
    }
  }

  private priority(emotion: FaceEmotion): number {
    switch (emotion) {
      case "angry":
      case "surprised":
        return 5;
      case "sad":
        return 4;
      case "happy":
      case "playful":
      case "affectionate":
        return 3;
      case "thinking":
      case "listen":
        return 2;
      default:
        return 0;
    }
  }

  /** Call every frame; lipsync/blink stay on separate tracks. */
  update(delta: number) {
    const mgr = this.vrm?.expressionManager;
    if (!mgr) return;

    const speed = 6; // roughly ~0.15s ease
    const t = 1 - Math.exp(-speed * Math.max(0, delta));

    for (const name of ALL_PRESETS) {
      if (!this.available.has(name)) continue;
      const next = this.current[name] + (this.target[name] - this.current[name]) * t;
      this.current[name] = next;
      try {
        mgr.setValue(name, next);
      } catch {
        this.available.delete(name);
      }
    }

    if (Date.now() > this.holdUntil && this.emotion !== "neutral") {
      this.setEmotion("neutral", 0, true);
    }
  }

  reset() {
    this.setEmotion("neutral", 0, true);
    for (const name of ALL_PRESETS) {
      this.current[name] = 0;
      this.target[name] = 0;
      try {
        this.vrm?.expressionManager?.setValue(name, 0);
      } catch {
        // ignore
      }
    }
  }
}

export const vrmFacialController = new VrmFacialController();
