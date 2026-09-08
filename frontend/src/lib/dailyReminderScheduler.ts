import { globalStateManager } from "./globalStateManager";
import { idleAmbientSpeech } from "./idleAmbientSpeech";
import { pipelineManager } from "./pipelineManager";
import { ttsManager } from "./ttsManager";

/** How often we scan for due reminders. */
const CHECK_INTERVAL_MS = 30_000;
/** Keep trying after the scheduled time until idle, up to this long. */
const GRACE_AFTER_DUE_MS = 45 * 60_000;
/** Wait at least this long after any activity before a reminder may fire. */
const QUIET_BEFORE_SPEAK_MS = 20_000;

const STORAGE_KEY = "dailyReminders.lastFired";

export type DailyReminderItem = {
  id: string;
  label: string;
  /** 24-hour local time, e.g. "08:30". */
  time: string;
  /** Hidden instruction sent to the LLM — the AI speaks proactively from this. */
  prompt: string;
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. Omit or empty = every day. */
  days?: number[];
};

export type DailyReminderOptions = {
  enabled?: boolean;
  items?: DailyReminderItem[];
};

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseTimeMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function dueTimestampToday(time: string): number | null {
  const minutes = parseTimeMinutes(time);
  if (minutes === null) return null;
  const due = new Date();
  due.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return due.getTime();
}

function readLastFired(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLastFired(map: Record<string, string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function dayMatches(item: DailyReminderItem, day: number): boolean {
  if (!item.days || item.days.length === 0) return true;
  return item.days.includes(day);
}

/**
 * Proactive daily check-ins: at configured local times the AI initiates caring
 * questions (meals, hydration, commute, rest) through the full LLM + TTS pipeline.
 */
class DailyReminderScheduler {
  private enabled = false;
  private items: DailyReminderItem[] = [];
  private started = false;
  private timer: number | null = null;
  private lastActivityAt = Date.now();
  private unsubscribers: Array<() => void> = [];

  start(options: DailyReminderOptions = {}) {
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    }
    if (options.items !== undefined) {
      this.items = options.items.filter((item) => item && item.id);
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

  setItems(items: DailyReminderItem[]) {
    this.items = items.filter((item) => item && item.id);
    if (this.started && this.enabled) {
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

  private reschedule() {
    this.clearTimer();
    if (!this.enabled || !this.started) return;
    this.timer = window.setTimeout(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
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

  private alreadyFiredToday(id: string): boolean {
    const lastFired = readLastFired();
    return lastFired[id] === todayKey();
  }

  private markFired(id: string) {
    const lastFired = readLastFired();
    lastFired[id] = todayKey();
    writeLastFired(lastFired);
  }

  private dueItems(): DailyReminderItem[] {
    const now = Date.now();
    const day = new Date().getDay();
    const due: DailyReminderItem[] = [];

    for (const item of this.items) {
      if (!item.enabled) continue;
      if (!dayMatches(item, day)) continue;
      if (this.alreadyFiredToday(item.id)) continue;

      const dueAt = dueTimestampToday(item.time);
      if (dueAt === null) continue;
      if (now < dueAt) continue;
      if (now > dueAt + GRACE_AFTER_DUE_MS) continue;

      due.push(item);
    }

    due.sort((a, b) => {
      const aDue = dueTimestampToday(a.time) ?? 0;
      const bDue = dueTimestampToday(b.time) ?? 0;
      return aDue - bDue;
    });

    return due;
  }

  private fireReminder(item: DailyReminderItem, markFired = true) {
    pipelineManager.addInputTask(item.prompt, { hideFromChat: true });
    if (markFired) {
      this.markFired(item.id);
    }
    this.bumpActivity();
    idleAmbientSpeech.bumpActivity();
  }

  /** Manual test from Settings — does not consume today's scheduled slot. */
  testReminder(item: DailyReminderItem): string | null {
    if (!this.enabled) {
      return "Nyalakan dulu toggle Reminder harian proaktif.";
    }
    if (!this.isTrulyIdle()) {
      return "Tunggu sampai tidak ada obrolan, suara, atau TTS aktif, lalu coba lagi.";
    }
    this.fireReminder(item, false);
    return null;
  }

  private async tick() {
    try {
      if (this.enabled) {
        const due = this.dueItems();
        if (due.length > 0 && this.isTrulyIdle()) {
          this.fireReminder(due[0]);
        }
      }
    } catch (err) {
      console.warn("Daily reminder scheduler failed:", err);
    } finally {
      this.reschedule();
    }
  }
}

export const dailyReminderScheduler = new DailyReminderScheduler();

export const DEFAULT_DAILY_REMINDERS: DailyReminderItem[] = [
  {
    id: "breakfast",
    label: "Sarapan",
    time: "07:00",
    prompt:
      "[Proactive daily check-in — you initiate, do not wait for the user] Warmly ask honey if they've had breakfast yet. One or two caring sentences.",
    enabled: true,
  },
  {
    id: "leave-for-work",
    label: "Berangkat kerja",
    time: "07:45",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they're ready to leave for work or already on their way. Keep it brief and supportive.",
    enabled: true,
    days: [1, 2, 3, 4, 5],
  },
  {
    id: "arrived-office",
    label: "Sampai kantor",
    time: "08:30",
    prompt:
      "[Proactive daily check-in — you initiate] Gently ask honey if they've arrived at the office safely. One or two warm sentences.",
    enabled: true,
    days: [1, 2, 3, 4, 5],
  },
  {
    id: "drink-water-morning",
    label: "Minum air (pagi)",
    time: "10:00",
    prompt:
      "[Proactive daily check-in — you initiate] Remind honey to drink some water and ask if they've had enough today. Stay light and caring.",
    enabled: true,
  },
  {
    id: "lunch",
    label: "Makan siang",
    time: "12:30",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they've eaten lunch yet and encourage them to take a proper break. One or two sentences.",
    enabled: true,
  },
  {
    id: "rest-break",
    label: "Istirahat",
    time: "15:00",
    prompt:
      "[Proactive daily check-in — you initiate] Suggest honey take a short rest or stretch break. Ask how their afternoon is going.",
    enabled: true,
  },
  {
    id: "drink-water-afternoon",
    label: "Minum air (sore)",
    time: "15:30",
    prompt:
      "[Proactive daily check-in — you initiate] Nudge honey to drink water again. Keep it playful and brief.",
    enabled: true,
  },
  {
    id: "leave-work",
    label: "Pulang kerja",
    time: "17:00",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they're wrapping up work and heading home soon. Be warm and relieved for them.",
    enabled: true,
    days: [1, 2, 3, 4, 5],
  },
  {
    id: "dinner",
    label: "Makan malam",
    time: "19:00",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they've had dinner yet. One or two caring sentences.",
    enabled: true,
  },
  {
    id: "wind-down",
    label: "Istirahat malam",
    time: "22:00",
    prompt:
      "[Proactive daily check-in — you initiate] Gently suggest honey wind down for the night soon. Ask how their day went in a warm, brief way.",
    enabled: true,
  },
];

export function normalizeDailyReminders(raw: unknown): DailyReminderItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_DAILY_REMINDERS.map((item) => ({ ...item }));
  }
  return raw
    .filter((item): item is DailyReminderItem => {
      return (
        item &&
        typeof item === "object" &&
        typeof (item as DailyReminderItem).id === "string" &&
        typeof (item as DailyReminderItem).time === "string" &&
        typeof (item as DailyReminderItem).prompt === "string"
      );
    })
    .map((item) => ({
      id: item.id,
      label: typeof item.label === "string" ? item.label : item.id,
      time: item.time,
      prompt: item.prompt,
      enabled: item.enabled !== false,
      days: Array.isArray(item.days) ? item.days.filter((d) => typeof d === "number") : undefined,
    }));
}
