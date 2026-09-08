import re
from typing import Any, Dict, List, Tuple

from .SkillLibraryStore import SkillLibraryStore
from .UserModelStore import UserModelStore


# (pattern, category, key)
FACT_PATTERNS: List[Tuple[str, str, str]] = [
    (
        r"(?:my favorite|favourite|favorit(?:e|ku)?|lagu favorit(?:ku)?(?:\s+(?:is|adalah))?)\s+(?:song|lagu)?\s*[:\-]?\s*(.+?)(?:[.!?]|$)",
        "interest",
        "favorite_song",
    ),
    (
        r"(?:lagu favorit(?:ku| saya)?)\s+(?:is|adalah|itu\s+)?(.+?)(?:[.!?]|$)",
        "interest",
        "favorite_song",
    ),
    (
        r"(?:my favorite song|favorite song(?:\s+is)?)\s+(?:is\s+)?(.+?)(?:[.!?]|$)",
        "interest",
        "favorite_song",
    ),
    (
        r"(?:my favorite|favorit(?:e|ku)?)\s+(?:food|makanan|drink|minuman|color|warna|movie|film|anime|game)\s+(?:is|adalah)?\s*(.+?)(?:[.!?]|$)",
        "preference",
        "favorite_{0}",
    ),
    (
        r"(?:i love|i really love|suka banget|sangat suka|really like)\s+(.+?)(?:[.!?]|$)",
        "preference",
        "likes",
    ),
    (
        r"(?:i hate|i don'?t like|tidak suka|benci)\s+(.+?)(?:[.!?]|$)",
        "preference",
        "dislikes",
    ),
    (
        r"(?:my name is|i'?m called|call me|panggil aku|nama saya(?:\s+adalah)?)\s+(.+?)(?:[.!?]|$)",
        "identity",
        "name",
    ),
    (
        r"(?:i work at|i work in|kerja di|bekerja di|my job is)\s+(.+?)(?:[.!?]|$)",
        "habit",
        "workplace",
    ),
    (
        r"(?:i(?:'m| am) from|dari kota|asal(?:ku)?(?:\s+dari)?)\s+(.+?)(?:[.!?]|$)",
        "identity",
        "origin",
    ),
    (
        r"(?:remember(?:\s+that|\s+this)?|ingat(?:\s+ya)?(?:\s+bahwa)?|jangan lupa(?:\s+bahwa)?)\s+(.+?)(?:[.!?]|$)",
        "fact",
        "remember",
    ),
    (
        r"(?:i usually|biasanya aku|i always|selalu)\s+(.+?)(?:[.!?]|$)",
        "habit",
        "routine",
    ),
]

CATEGORY_SKILL_HINTS: Dict[str, str] = {
    "interest": "Reference their stated interests naturally; show you remember what they enjoy.",
    "preference": "Align suggestions and tone with their likes and dislikes.",
    "identity": "Use their name and background warmly when appropriate.",
    "habit": "Acknowledge their routines and daily life patterns.",
    "fact": "Treat remembered facts as established — do not ask them to repeat.",
}


class MemoryConsolidator:
    """Learning loop — extract facts and skills from recent conversation turns."""

    def __init__(self, user_model: UserModelStore, skill_library: SkillLibraryStore):
        self.user_model = user_model
        self.skill_library = skill_library

    def _clean_capture(self, text: str) -> str:
        text = text.strip().strip("\"'")
        text = re.sub(r"\s+", " ", text)
        return text[:400]

    def extract_facts_from_messages(
        self,
        messages: List[Dict[str, str]],
        session_id: str = "",
    ) -> List[Dict[str, Any]]:
        if not messages:
            return []

        extracted: List[Dict[str, Any]] = []
        user_texts = [
            m.get("content", "")
            for m in messages
            if m.get("role") == "user" and isinstance(m.get("content"), str)
        ]

        for content in user_texts:
            for pattern, category, key in FACT_PATTERNS:
                for match in re.finditer(pattern, content, re.IGNORECASE):
                    value = self._clean_capture(match.group(1))
                    if len(value) < 2:
                        continue
                    fact = self.user_model.upsert_fact(
                        category=category,
                        key=key,
                        value=value,
                        source_session=session_id,
                        confidence=0.88,
                        pinned=(category == "identity"),
                    )
                    if fact:
                        extracted.append(fact)

        return extracted

    def _skill_from_fact(self, fact: Dict[str, Any]) -> None:
        category = fact.get("category", "general")
        key = str(fact.get("key", "")).replace("_", " ")
        value = fact.get("value", "")
        hint = CATEGORY_SKILL_HINTS.get(category, "Use this personal detail naturally in conversation.")

        trigger = f"conversation about {key} or {value[:60]}"
        guidance = f"{hint} ({key}: {value})."
        self.skill_library.upsert_skill(
            trigger=trigger,
            guidance=guidance,
            category=category,
            source=f"fact:{fact.get('id', '')}",
        )

    def consolidate_messages(
        self,
        messages: List[Dict[str, str]],
        session_id: str = "",
        *,
        recent_only: int = 20,
    ) -> Dict[str, Any]:
        """Review recent turns, extract facts, update skill library."""
        slice_msgs = messages[-recent_only:] if recent_only else messages
        facts = self.extract_facts_from_messages(slice_msgs, session_id=session_id)

        new_skills = 0
        for fact in facts:
            before = len(self.skill_library.get_all_skills())
            self._skill_from_fact(fact)
            if len(self.skill_library.get_all_skills()) > before:
                new_skills += 1

        return {
            "facts_extracted": len(facts),
            "skills_updated": new_skills,
            "total_facts": len(self.user_model.get_all_facts()),
            "total_skills": len(self.skill_library.get_all_skills()),
        }
