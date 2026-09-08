import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List


class SkillLibraryStore:
    """Tier 4 — procedural memory: learned interaction patterns and response hints."""

    MAX_SKILLS = 80

    def __init__(self, filename: str = "skill_library.json"):
        self.path = os.path.join(os.path.dirname(__file__), filename)
        self._data = self._load()

    def _load(self) -> Dict[str, Any]:
        if not os.path.exists(self.path):
            return {"version": 1, "updated_at": None, "skills": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return {"version": 1, "updated_at": None, "skills": []}
            data.setdefault("skills", [])
            return data
        except (json.JSONDecodeError, OSError):
            return {"version": 1, "updated_at": None, "skills": []}

    def _save(self) -> None:
        self._data["updated_at"] = datetime.now().isoformat()
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    def get_all_skills(self) -> List[Dict[str, Any]]:
        return list(self._data.get("skills", []))

    def upsert_skill(
        self,
        trigger: str,
        guidance: str,
        *,
        category: str = "general",
        source: str = "",
    ) -> Dict[str, Any]:
        trigger = trigger.strip()[:200]
        guidance = guidance.strip()[:500]
        if not trigger or not guidance:
            return {}

        trigger_norm = trigger.lower()
        skills: List[Dict[str, Any]] = self._data.setdefault("skills", [])
        now = datetime.now().isoformat()

        for skill in skills:
            if skill.get("trigger", "").lower() == trigger_norm:
                skill["guidance"] = guidance
                skill["frequency"] = int(skill.get("frequency", 1)) + 1
                skill["last_used_at"] = now
                if source:
                    skill["source"] = source
                self._save()
                return skill

        entry = {
            "id": str(uuid.uuid4()),
            "category": category[:40],
            "trigger": trigger,
            "guidance": guidance,
            "frequency": 1,
            "source": source,
            "created_at": now,
            "last_used_at": now,
        }
        skills.append(entry)

        if len(skills) > self.MAX_SKILLS:
            skills.sort(key=lambda s: (int(s.get("frequency", 0)), s.get("last_used_at", "")))
            self._data["skills"] = skills[-self.MAX_SKILLS :]

        self._save()
        return entry

    def delete_skill(self, skill_id: str) -> bool:
        skills = self._data.get("skills", [])
        new_skills = [s for s in skills if s.get("id") != skill_id]
        if len(new_skills) == len(skills):
            return False
        self._data["skills"] = new_skills
        self._save()
        return True

    def _tokenize(self, text: str) -> set:
        return {t for t in re.findall(r"[a-z0-9\u0080-\uffff]+", text.lower()) if len(t) > 2}

    def get_relevant_skills(self, query: str, limit: int = 3) -> List[Dict[str, Any]]:
        skills = self.get_all_skills()
        if not skills:
            return []

        query_tokens = self._tokenize(query)
        scored: List[tuple] = []

        for skill in skills:
            text = f"{skill.get('trigger', '')} {skill.get('guidance', '')} {skill.get('category', '')}"
            tokens = self._tokenize(text)
            overlap = len(query_tokens & tokens) if query_tokens else 0
            score = overlap * 2 + int(skill.get("frequency", 1)) * 0.3
            scored.append((score, skill))

        scored.sort(key=lambda x: x[0], reverse=True)
        top = [s for sc, s in scored if sc > 0][:limit]
        if top:
            return top
        ranked = sorted(skills, key=lambda s: int(s.get("frequency", 0)), reverse=True)
        return ranked[:limit]

    def to_context_text(self, query: str, limit: int = 3) -> str:
        skills = self.get_relevant_skills(query, limit=limit)
        if not skills:
            return ""
        lines = ["[LEARNED PATTERNS — how to respond to this user]"]
        for skill in skills:
            lines.append(f"- When: {skill.get('trigger', '')} → {skill.get('guidance', '')}")
        return "\n".join(lines)
