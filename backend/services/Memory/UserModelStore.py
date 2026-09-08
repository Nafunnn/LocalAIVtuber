import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional


class UserModelStore:
    """Tier 3 — semantic long-term memory: structured facts about the user."""

    MAX_FACTS = 200

    def __init__(self, filename: str = "user_model.json"):
        self.path = os.path.join(os.path.dirname(__file__), filename)
        self._data = self._load()

    def _load(self) -> Dict[str, Any]:
        if not os.path.exists(self.path):
            return {"version": 1, "updated_at": None, "facts": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return {"version": 1, "updated_at": None, "facts": []}
            data.setdefault("facts", [])
            return data
        except (json.JSONDecodeError, OSError):
            return {"version": 1, "updated_at": None, "facts": []}

    def _save(self) -> None:
        self._data["updated_at"] = datetime.now().isoformat()
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    def get_all_facts(self) -> List[Dict[str, Any]]:
        return list(self._data.get("facts", []))

    def upsert_fact(
        self,
        category: str,
        key: str,
        value: str,
        *,
        source_session: str = "",
        confidence: float = 0.85,
        pinned: bool = False,
    ) -> Dict[str, Any]:
        value = value.strip()
        if not value or len(value) > 500:
            return {}

        key_norm = re.sub(r"\s+", "_", key.strip().lower())[:80]
        category_norm = category.strip().lower()[:40]
        now = datetime.now().isoformat()

        facts: List[Dict[str, Any]] = self._data.setdefault("facts", [])
        for fact in facts:
            if fact.get("key") == key_norm and fact.get("category") == category_norm:
                fact["value"] = value
                fact["last_seen_at"] = now
                fact["confidence"] = max(float(fact.get("confidence", 0)), confidence)
                if source_session:
                    fact["source_session"] = source_session
                if pinned:
                    fact["pinned"] = True
                self._save()
                return fact

        entry = {
            "id": str(uuid.uuid4()),
            "category": category_norm,
            "key": key_norm,
            "value": value,
            "source_session": source_session,
            "confidence": confidence,
            "pinned": pinned,
            "created_at": now,
            "last_seen_at": now,
        }
        facts.append(entry)

        if len(facts) > self.MAX_FACTS:
            facts.sort(
                key=lambda f: (
                    1 if f.get("pinned") else 0,
                    float(f.get("confidence", 0)),
                    f.get("last_seen_at", ""),
                )
            )
            self._data["facts"] = facts[-self.MAX_FACTS :]

        self._save()
        return entry

    def delete_fact(self, fact_id: str) -> bool:
        facts = self._data.get("facts", [])
        new_facts = [f for f in facts if f.get("id") != fact_id]
        if len(new_facts) == len(facts):
            return False
        self._data["facts"] = new_facts
        self._save()
        return True

    def _tokenize(self, text: str) -> set:
        return {t for t in re.findall(r"[a-z0-9\u0080-\uffff]+", text.lower()) if len(t) > 2}

    def get_facts_for_query(self, query: str, limit: int = 12) -> List[Dict[str, Any]]:
        facts = self.get_all_facts()
        if not facts:
            return []

        query_tokens = self._tokenize(query)
        scored: List[tuple] = []

        for fact in facts:
            score = 0.0
            if fact.get("pinned"):
                score += 3.0
            if fact.get("category") in ("identity", "preference", "interest"):
                score += 1.0

            fact_text = f"{fact.get('key', '')} {fact.get('value', '')} {fact.get('category', '')}"
            fact_tokens = self._tokenize(fact_text)
            if query_tokens and fact_tokens:
                overlap = len(query_tokens & fact_tokens)
                score += overlap * 2.0

            score += float(fact.get("confidence", 0.5)) * 0.5
            scored.append((score, fact))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [f for _, f in scored[:limit]]

    def get_profile_bullets(self, max_items: int = 10) -> List[str]:
        """Compact always-on profile — pinned + high-confidence facts, no vector search."""
        facts = self.get_all_facts()
        if not facts:
            return []

        ranked = sorted(
            facts,
            key=lambda f: (
                1 if f.get("pinned") else 0,
                float(f.get("confidence", 0)),
                f.get("last_seen_at", ""),
            ),
            reverse=True,
        )

        bullets: List[str] = []
        seen_keys: set = set()
        for fact in ranked:
            key = fact.get("key", "")
            if key in seen_keys:
                continue
            seen_keys.add(key)
            cat = fact.get("category", "fact")
            val = fact.get("value", "")
            if not val:
                continue
            label = key.replace("_", " ")
            bullets.append(f"- [{cat}] {label}: {val}")
            if len(bullets) >= max_items:
                break
        return bullets

    def to_context_text(self, query: str, fact_limit: int = 12, profile_limit: int = 8) -> str:
        profile_lines = self.get_profile_bullets(max_items=profile_limit)
        relevant = self.get_facts_for_query(query, limit=fact_limit)

        profile_ids = set()
        for fact in self.get_all_facts():
            for line in profile_lines:
                val = fact.get("value", "")
                if val and val in line:
                    profile_ids.add(fact.get("id"))

        sections: List[str] = []
        if profile_lines:
            sections.append("[USER PROFILE — persistent facts about honey]")
            sections.extend(profile_lines)

        query_lines: List[str] = []
        for fact in relevant:
            if fact.get("id") in profile_ids:
                continue
            cat = fact.get("category", "fact")
            key = str(fact.get("key", "")).replace("_", " ")
            val = fact.get("value", "")
            query_lines.append(f"- [{cat}] {key}: {val}")

        if query_lines:
            sections.append("[QUERY-RELEVANT USER FACTS]")
            sections.extend(query_lines[: max(0, fact_limit)])

        return "\n".join(sections)
