import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  consolidateAllSessions,
  deleteSkill,
  deleteUserFact,
  fetchMemoryStats,
  fetchSkills,
  fetchUserFacts,
  reindexAllSessionsMemory,
  upsertUserFact,
  type LearnedSkill,
  type MemoryStats,
  type UserFact,
} from "@/lib/memoryManager";
import { toast } from "sonner";
import { Brain, RefreshCcw, Trash2 } from "lucide-react";

export default function UserModelPanel() {
  const [facts, setFacts] = useState<UserFact[]>([]);
  const [skills, setSkills] = useState<LearnedSkill[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [f, s, st] = await Promise.all([
        fetchUserFacts(),
        fetchSkills(),
        fetchMemoryStats(),
      ]);
      setFacts(f);
      setSkills(s);
      setStats(st);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAddFact = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    setBusy(true);
    try {
      const ok = await upsertUserFact("preference", newKey.trim(), newValue.trim(), true);
      if (ok) {
        toast.success("Fact saved to long-term memory");
        setNewKey("");
        setNewValue("");
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleBackfill = async () => {
    setBusy(true);
    try {
      toast.info("Scanning all past chats for facts…");
      const result = await consolidateAllSessions();
      await reindexAllSessionsMemory();
      await reload();
      toast.success(
        `Backfill done — processed ${result?.sessions_processed ?? 0} sessions`
      );
    } catch {
      toast.error("Backfill failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Long-term memory
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Tier 3 (user facts) and Tier 4 (learned patterns) load instantly without
            heavy vector search. Episodic memory is indexed automatically after each chat.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleBackfill()}>
          <RefreshCcw className="mr-1.5 h-4 w-4" />
          Backfill from all chats
        </Button>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">{stats.facts} facts</Badge>
          <Badge variant="secondary">{stats.skills} learned patterns</Badge>
        </div>
      )}

      <div className="rounded-md border p-4 space-y-3">
        <Label className="text-sm font-medium">Add a fact manually</Label>
        <p className="text-xs text-muted-foreground">
          Example: key <code>favorite_song</code>, value <code>Your song name</code>
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <Input
            placeholder="Key (e.g. favorite_song)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <Input
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={busy} onClick={() => void handleAddFact()}>
          Save fact
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0">
        <div className="rounded-md border flex flex-col min-h-[280px]">
          <div className="border-b px-3 py-2 text-sm font-medium">User facts (Tier 3)</div>
          <ScrollArea className="flex-1 p-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : facts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No facts yet. Chat naturally (“my favorite song is …”) or use Backfill.
              </p>
            ) : (
              <ul className="space-y-2">
                {facts.map((fact) => (
                  <li key={fact.id} className="rounded border px-2 py-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">
                        [{fact.category}] {fact.key.replace(/_/g, " ")}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() =>
                          void deleteUserFact(fact.id).then(() => reload())
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="text-muted-foreground mt-0.5">{fact.value}</p>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>

        <div className="rounded-md border flex flex-col min-h-[280px]">
          <div className="border-b px-3 py-2 text-sm font-medium">Learned patterns (Tier 4)</div>
          <ScrollArea className="flex-1 p-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : skills.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Patterns appear as the learning loop extracts facts from your chats.
              </p>
            ) : (
              <ul className="space-y-2">
                {skills.map((skill) => (
                  <li key={skill.id} className="rounded border px-2 py-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-xs text-muted-foreground">{skill.category}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => void deleteSkill(skill.id).then(() => reload())}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="mt-0.5">
                      <span className="font-medium">When:</span> {skill.trigger}
                    </p>
                    <p className="text-muted-foreground text-xs mt-0.5">{skill.guidance}</p>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
