export type UserFact = {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence?: number;
  pinned?: boolean;
  created_at?: string;
  last_seen_at?: string;
};

export type LearnedSkill = {
  id: string;
  category: string;
  trigger: string;
  guidance: string;
  frequency?: number;
  created_at?: string;
  last_used_at?: string;
};

export type MemoryStats = {
  facts: number;
  skills: number;
  user_model_updated_at?: string | null;
  skill_library_updated_at?: string | null;
};

export async function fetchMemoryStats(): Promise<MemoryStats | null> {
  try {
    const res = await fetch("/api/memory/stats");
    if (!res.ok) return null;
    return (await res.json()) as MemoryStats;
  } catch {
    return null;
  }
}

export async function fetchUserFacts(): Promise<UserFact[]> {
  try {
    const res = await fetch("/api/memory/user-model");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.facts) ? data.facts : [];
  } catch {
    return [];
  }
}

export async function upsertUserFact(
  category: string,
  key: string,
  value: string,
  pinned = false
): Promise<boolean> {
  const res = await fetch("/api/memory/user-model/fact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, key, value, pinned }),
  });
  return res.ok;
}

export async function deleteUserFact(factId: string): Promise<boolean> {
  const res = await fetch(`/api/memory/user-model/fact/${factId}`, { method: "DELETE" });
  return res.ok;
}

export async function fetchSkills(): Promise<LearnedSkill[]> {
  try {
    const res = await fetch("/api/memory/skills");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.skills) ? data.skills : [];
  } catch {
    return [];
  }
}

export async function deleteSkill(skillId: string): Promise<boolean> {
  const res = await fetch(`/api/memory/skills/${skillId}`, { method: "DELETE" });
  return res.ok;
}

export async function consolidateAllSessions(): Promise<{ sessions_processed?: number } | null> {
  try {
    const sessionsRes = await fetch("/api/chat/sessions");
    if (!sessionsRes.ok) return null;
    const sessions = await sessionsRes.json();
    let totalFacts = 0;
    for (const meta of sessions) {
      const detailRes = await fetch(`/api/chat/session/${meta.id}`);
      if (!detailRes.ok) continue;
      const session = await detailRes.json();
      const history = session.history || [];
      if (history.length === 0) continue;
      const res = await fetch("/api/memory/consolidate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: meta.id, history }),
      });
      if (res.ok) {
        const data = await res.json();
        totalFacts += data.facts_extracted || 0;
      }
    }
    return { sessions_processed: sessions.length, facts_extracted: totalFacts } as {
      sessions_processed?: number;
      facts_extracted?: number;
    };
  } catch {
    return null;
  }
}

export async function reindexAllSessionsMemory(): Promise<boolean> {
  const res = await fetch("/api/memory/reindex-all-sessions", { method: "POST" });
  return res.ok;
}
