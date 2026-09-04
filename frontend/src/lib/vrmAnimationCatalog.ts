/** Catalog of VRM Animation (.vrma) files under Character/VRM3D/animations */

export type GestureMood =
  | "ambient"
  | "listen"
  | "think"
  | "speak"
  | "greet"
  | "playful"
  | "pose";

export interface VrmGesture {
  file: string;
  moods: GestureMood[];
  /** Prefer once when conversation starts */
  greetOnStart?: boolean;
  keywords?: RegExp;
}

const BASE = "/api/character/files/VRM3D/animations";

export const IDLE_ANIMATION = `${BASE}/idle.vrma`;

export const VRM_GESTURES: VrmGesture[] = [
  {
    file: `${BASE}/greeting.vrma`,
    moods: ["greet", "speak", "ambient"],
    greetOnStart: true,
    keywords: /\b(hi|hello|hey|greetings?|good (morning|afternoon|evening)|wave)\b|halo|hai|selamat/i,
  },
  {
    file: `${BASE}/v-sign.vrma`,
    moods: ["playful", "speak", "ambient"],
    keywords: /\b(peace|v[\s-]?sign|cute|kawaii|smile|cheer)\b|imut|lucu/i,
  },
  {
    file: `${BASE}/spinning.vrma`,
    moods: ["playful", "speak"],
    keywords: /\b(spin|dance|twirl|yay|woo+|excited|happy|celebrate)\b|senang|gembira|putar/i,
  },
  {
    file: `${BASE}/shooting.vrma`,
    moods: ["playful"],
    keywords: /\b(shoot|bang|pew|gun|action|play fight)\b/i,
  },
  {
    file: `${BASE}/squatting.vrma`,
    moods: ["think", "listen", "ambient"],
    keywords: /\b(think|thinking|hmm+|wonder|consider|wait|hold on)\b|pikir|tunggu/i,
  },
  {
    file: `${BASE}/model_pose.vrma`,
    moods: ["pose", "listen", "ambient"],
    keywords: /\b(pose|model|photo|picture|look at me|selfie)\b|pose|foto/i,
  },
  {
    file: `${BASE}/showing_the_whole_body.vrma`,
    moods: ["pose", "greet"],
    keywords: /\b(full body|whole body|show yourself|look at you|outfit)\b|seluruh tubuh|tampilkan/i,
  },
];

function pickRandom<T>(items: T[]): T | null {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}

export function gesturesForMood(mood: GestureMood): VrmGesture[] {
  return VRM_GESTURES.filter((g) => g.moods.includes(mood));
}

export function pickGestureForMood(mood: GestureMood, excludeFile?: string | null): string | null {
  const pool = gesturesForMood(mood).filter((g) => g.file !== excludeFile);
  return pickRandom(pool.length ? pool : gesturesForMood(mood))?.file ?? null;
}

export function pickAmbientGesture(excludeFile?: string | null): string | null {
  return pickGestureForMood("ambient", excludeFile);
}

export function pickGestureFromText(text: string): string | null {
  if (!text.trim()) return null;
  const matches = VRM_GESTURES.filter((g) => g.keywords?.test(text));
  return pickRandom(matches)?.file ?? null;
}

export function pickGreetingGesture(): string | null {
  const greet = VRM_GESTURES.filter((g) => g.greetOnStart);
  return pickRandom(greet)?.file ?? pickGestureForMood("greet");
}
