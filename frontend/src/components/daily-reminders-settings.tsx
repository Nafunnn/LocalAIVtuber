import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import SettingSwitch from "@/components/setting-switch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSettings } from "@/context/SettingsContext";
import {
  DEFAULT_DAILY_REMINDERS,
  dailyReminderScheduler,
  normalizeDailyReminders,
  type DailyReminderItem,
} from "@/lib/dailyReminderScheduler";

const DAY_LABELS = [
  { value: 1, label: "Sen" },
  { value: 2, label: "Sel" },
  { value: 3, label: "Rab" },
  { value: 4, label: "Kam" },
  { value: 5, label: "Jum" },
  { value: 6, label: "Sab" },
  { value: 0, label: "Min" },
];

const REMINDER_PRESETS: Array<Omit<DailyReminderItem, "id">> = [
  {
    label: "Sarapan",
    time: "07:00",
    prompt:
      "[Proactive daily check-in — you initiate] Warmly ask honey if they've had breakfast yet. One or two caring sentences.",
    enabled: true,
  },
  {
    label: "Makan siang",
    time: "12:30",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they've eaten lunch yet. One or two sentences.",
    enabled: true,
  },
  {
    label: "Makan malam",
    time: "19:00",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they've had dinner yet. One or two caring sentences.",
    enabled: true,
  },
  {
    label: "Minum air",
    time: "10:00",
    prompt:
      "[Proactive daily check-in — you initiate] Remind honey to drink some water. Keep it light and caring.",
    enabled: true,
  },
  {
    label: "Istirahat",
    time: "15:00",
    prompt:
      "[Proactive daily check-in — you initiate] Suggest honey take a short rest or stretch break.",
    enabled: true,
  },
  {
    label: "Berangkat kerja",
    time: "07:45",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they're ready to leave for work or already on their way.",
    enabled: true,
    days: [1, 2, 3, 4, 5],
  },
  {
    label: "Sampai kantor",
    time: "08:30",
    prompt:
      "[Proactive daily check-in — you initiate] Gently ask honey if they've arrived at the office safely.",
    enabled: true,
    days: [1, 2, 3, 4, 5],
  },
  {
    label: "Pulang kerja",
    time: "17:00",
    prompt:
      "[Proactive daily check-in — you initiate] Ask honey if they're wrapping up work and heading home soon.",
    enabled: true,
    days: [1, 2, 3, 4, 5],
  },
];

function cloneItems(items: DailyReminderItem[]): DailyReminderItem[] {
  return items.map((item) => ({
    ...item,
    days: item.days ? [...item.days] : undefined,
  }));
}

function itemsEqual(a: DailyReminderItem[], b: DailyReminderItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function DailyRemindersSettings() {
  const { settings, updateSetting } = useSettings();

  const savedItems = useMemo(
    () => normalizeDailyReminders(settings["frontend.dailyReminders.items"]),
    [settings]
  );

  const [draftItems, setDraftItems] = useState<DailyReminderItem[]>(() => cloneItems(savedItems));
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const dirty = !itemsEqual(draftItems, savedItems);

  useEffect(() => {
    if (!dirty) {
      setDraftItems(cloneItems(savedItems));
    }
  }, [savedItems, dirty]);

  const updateItem = (id: string, patch: Partial<DailyReminderItem>) => {
    setDraftItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
    setSaveMessage(null);
  };

  const removeItem = (id: string) => {
    setDraftItems((prev) => prev.filter((item) => item.id !== id));
    setSaveMessage(null);
  };

  const addPreset = (preset: Omit<DailyReminderItem, "id">) => {
    setDraftItems((prev) => [...prev, { ...preset, id: uuidv4() }]);
    setSaveMessage(null);
  };

  const resetDefaults = () => {
    setDraftItems(DEFAULT_DAILY_REMINDERS.map((item) => ({ ...item })));
    setSaveMessage(null);
  };

  const discardChanges = () => {
    setDraftItems(cloneItems(savedItems));
    setSaveMessage(null);
  };

  const saveItems = useCallback(async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await updateSetting("frontend.dailyReminders.items", cloneItems(draftItems));
      setSaveMessage("Tersimpan.");
    } catch (err) {
      console.error(err);
      setSaveMessage("Gagal menyimpan. Coba lagi.");
    } finally {
      setSaving(false);
    }
  }, [draftItems, updateSetting]);

  const toggleDay = (id: string, day: number, checked: boolean) => {
    const item = draftItems.find((entry) => entry.id === id);
    if (!item) return;
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const current = item.days && item.days.length > 0 ? item.days : allDays;
    const next = checked
      ? [...new Set([...current, day])].sort((a, b) => a - b)
      : current.filter((value) => value !== day);
    updateItem(id, {
      days: next.length >= allDays.length ? undefined : next.length > 0 ? next : undefined,
    });
  };

  return (
    <div className="flex flex-col gap-4 w-full">
      <SettingSwitch
        id="frontend.dailyReminders.enabled"
        label="Reminder harian proaktif"
        description="AI akan sendiri bertanya tentang makan, minum, istirahat, dan kegiatan harianmu sesuai jadwal."
      />
      <p className="text-xs text-muted-foreground -mt-2">
        Tab browser harus tetap terbuka. Reminder hanya muncul saat idle (tidak ada obrolan/TTS). Edit di bawah
        dulu, lalu tekan Simpan. Gunakan tombol Test untuk coba langsung (pakai draft yang sedang terlihat).
      </p>

      <div className="flex flex-wrap gap-2">
        {REMINDER_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => addPreset(preset)}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {preset.label}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={resetDefaults}>
          Reset default
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {draftItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Belum ada reminder. Tambahkan dari preset di atas atau reset ke default.
          </p>
        ) : (
          draftItems.map((item) => (
            <div
              key={item.id}
              className="rounded-md border bg-muted/20 p-3 flex flex-col gap-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`reminder-enabled-${item.id}`}
                    checked={item.enabled}
                    onCheckedChange={(checked) =>
                      updateItem(item.id, { enabled: checked === true })
                    }
                  />
                  <Label htmlFor={`reminder-enabled-${item.id}`} className="text-sm">
                    Aktif
                  </Label>
                </div>
                <Input
                  type="time"
                  value={item.time}
                  onChange={(e) => updateItem(item.id, { time: e.target.value })}
                  className="w-32"
                />
                <Input
                  value={item.label}
                  onChange={(e) => updateItem(item.id, { label: e.target.value })}
                  placeholder="Label"
                  className="min-w-[140px] flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const err = dailyReminderScheduler.testReminder(item);
                    if (err) window.alert(err);
                  }}
                >
                  Test
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeItem(item.id)}
                  aria-label={`Hapus ${item.label}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {DAY_LABELS.map(({ value, label }) => {
                  const active =
                    !item.days || item.days.length === 0 || item.days.includes(value);
                  return (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                        active ? "border-primary/50 bg-primary/10" : "opacity-50"
                      }`}
                    >
                      <Checkbox
                        checked={active}
                        onCheckedChange={(checked) =>
                          toggleDay(item.id, value, checked === true)
                        }
                        className="h-3 w-3"
                      />
                      {label}
                    </label>
                  );
                })}
                <span className="self-center text-xs text-muted-foreground">
                  (kosong = setiap hari)
                </span>
              </div>

              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Instruksi untuk AI (opsional)
                </summary>
                <Textarea
                  value={item.prompt}
                  onChange={(e) => updateItem(item.id, { prompt: e.target.value })}
                  className="mt-2 min-h-[72px]"
                />
              </details>
            </div>
          ))
        )}
      </div>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background/95 py-3 backdrop-blur">
        <Button type="button" onClick={() => void saveItems()} disabled={!dirty || saving}>
          {saving ? "Menyimpan…" : "Simpan"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={discardChanges}
          disabled={!dirty || saving}
        >
          Batalkan
        </Button>
        {dirty ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Ada perubahan yang belum disimpan
          </span>
        ) : saveMessage ? (
          <span className="text-xs text-muted-foreground">{saveMessage}</span>
        ) : null}
      </div>
    </div>
  );
}

export default DailyRemindersSettings;
