/** Catalog of VRM Animation (.vrma) files under Character/VRM3D/animations */

export type GestureMood =
  | "ambient"
  | "listen"
  | "think"
  | "speak"
  | "greet"
  | "playful"
  | "pose"
  | "apology"
  | "encourage";

export interface VrmGesture {
  file: string;
  moods: GestureMood[];
  /** Prefer once when conversation starts */
  greetOnStart?: boolean;
  keywords?: RegExp;
}

const BASE = "/api/character/files/VRM3D/animations";

export const IDLE_ANIMATION = `${BASE}/idle.vrma`;
export const SMARTPHONE_ANIMATION = `${BASE}/smartphone.vrma`;

/** Same intent cues as backend MCP browser agent — keep in sync when possible. */
const BROWSER_INTENT_RE =
  /\b(google|search|browse|browser|website|web\b|navigate|look\s*up|lookup|find online|youtube\.com|wikipedia|http:\/\/|https:\/\/|open (https?|www|chrome|tab)|go to (https?|www))\b|cari (di|ke)? ?(google|web|internet|browser)|buka (web|browser|chrome|youtube|google)|telusuri/i;

export function looksLikeBrowserRequest(text: string): boolean {
  return BROWSER_INTENT_RE.test(text || "");
}

export function pickSmartphoneGesture(): string {
  return SMARTPHONE_ANIMATION;
}

export const VRM_GESTURES: VrmGesture[] = [
  // --- Greetings ---
  {
    file: `${BASE}/greeting.vrma`,
    moods: ["greet", "speak", "ambient"],
    greetOnStart: true,
    keywords: /\b(hi|hello|hey|greetings?|good (morning|afternoon|evening)|wave)\b|halo|hai|selamat (pagi|siang|sore|malam)/i,
  },
  {
    file: `${BASE}/hello.vrma`,
    moods: ["greet", "speak", "ambient"],
    greetOnStart: true,
    keywords: /\b(hello there|hi there|yo\b|sup\b)\b|halo+|hai hai/i,
  },

  // --- Listening / waiting / thinking ---
  {
    file: `${BASE}/waiting.vrma`,
    moods: ["listen", "think", "ambient"],
    keywords: /\b(wait|waiting|hold on|one (sec|moment|minute)|hang on)\b|tunggu|sebentar/i,
  },
  {
    file: `${BASE}/squatting.vrma`,
    moods: ["think", "listen", "ambient"],
    keywords: /\b(think|thinking|hmm+|wonder|consider)\b|pikir|memikirkan/i,
  },
  {
    file: `${BASE}/smartphone.vrma`,
    moods: ["listen", "ambient", "think"],
    keywords:
      /\b(phone|smartphone|text(ing)?|message|scroll|instagram|tiktok|google|search|browse|browser|website|web\b|navigate|look\s*up|wikipedia|youtube)\b|hp|ponsel|chat|cari|browser|google/i,
  },
  {
    file: `${BASE}/drinking_water.vrma`,
    moods: ["ambient", "listen"],
    keywords: /\b(drink|drinking|water|thirsty|sip)\b|minum|haus/i,
  },

  // --- Speak / emotional ---
  {
    file: `${BASE}/encouraging.vrma`,
    moods: ["encourage", "speak", "playful"],
    keywords: /\b(you (can|got this)|cheer up|encourage|proud of you|keep going|don't give up|fighting)\b|semangat|ayo|bisa|jangan menyerah/i,
  },
  {
    file: `${BASE}/bowing_in_apology.vrma`,
    moods: ["apology", "speak"],
    keywords: /\b(sorry|apologize|apology|my bad|forgive me|excuse me)\b|maaf|mohon maaf|ampun/i,
  },

  // --- Playful ---
  {
    file: `${BASE}/v-sign.vrma`,
    moods: ["playful", "speak", "ambient"],
    keywords: /\b(peace|v[\s-]?sign|cute|kawaii|smile|cheer)\b|imut|lucu/i,
  },
  {
    file: `${BASE}/spinning.vrma`,
    moods: ["playful", "speak", "ambient"],
    keywords: /\b(spin|dance|twirl|yay|woo+|excited|happy|celebrate)\b|senang|gembira|putar|joget/i,
  },
  {
    file: `${BASE}/shooting.vrma`,
    moods: ["playful", "ambient"],
    keywords: /\b(shoot|bang|pew|gun|action|play fight)\b/i,
  },
  {
    file: `${BASE}/step-ups.vrma`,
    moods: ["playful", "ambient", "encourage"],
    keywords: /\b(exercise|workout|step[\s-]?up|fitness|train|stretch)\b|olahraga|latihan/i,
  },

  // --- Pose / present ---
  {
    file: `${BASE}/model_pose.vrma`,
    moods: ["pose", "listen", "ambient"],
    keywords: /\b(pose|model|photo|picture|look at me|selfie)\b|foto/i,
  },
  {
    file: `${BASE}/motion_pose.vrma`,
    moods: ["pose", "speak", "ambient"],
    keywords: /\b(motion|move|show (me )?how|strike a pose)\b|gerakan|bergaya/i,
  },
  {
    file: `${BASE}/showing_the_whole_body.vrma`,
    moods: ["pose", "greet", "ambient"],
    keywords: /\b(full body|whole body|show yourself|look at you|outfit|clothes)\b|seluruh tubuh|tampilkan|outfit/i,
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

/** All gesture files currently registered (excludes idle). */
export function listRegisteredGestureFiles(): string[] {
  return VRM_GESTURES.map((g) => g.file);
}
