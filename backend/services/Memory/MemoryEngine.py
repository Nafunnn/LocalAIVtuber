from typing import Any, Dict, List, Optional

from .Memory import Memory
from .SkillLibraryStore import SkillLibraryStore
from .UserModelStore import UserModelStore


class MemoryEngine:
    """
    Four-tier memory retrieval:
      Tier 1 — Working memory (current chat history; handled on frontend)
      Tier 2 — Episodic memory (vector-indexed past conversations)
      Tier 3 — Semantic memory (structured user facts / user model)
      Tier 4 — Procedural memory (learned skill library)
    """

    def __init__(
        self,
        memory: Memory,
        user_model: UserModelStore,
        skill_library: SkillLibraryStore,
    ):
        self.memory = memory
        self.user_model = user_model
        self.skill_library = skill_library

    def build_context(
        self,
        query: str,
        *,
        episodic_limit: int = 5,
        document_limit: int = 3,
        fact_limit: int = 12,
        skill_limit: int = 3,
        profile_limit: int = 8,
        include_user_model: bool = True,
        include_skills: bool = True,
    ) -> Dict[str, Any]:
        episodic = self.memory.query(query, limit=max(1, episodic_limit))
        documents = self.memory.query_documents(query, limit=max(1, document_limit))

        user_model_text = ""
        skills_text = ""
        facts: List[Dict[str, Any]] = []
        skills: List[Dict[str, Any]] = []

        if include_user_model:
            facts = self.user_model.get_facts_for_query(query, limit=fact_limit)
            user_model_text = self.user_model.to_context_text(
                query,
                fact_limit=fact_limit,
                profile_limit=profile_limit,
            )

        if include_skills:
            skills = self.skill_library.get_relevant_skills(query, limit=skill_limit)
            skills_text = self.skill_library.to_context_text(query, limit=skill_limit)

        return {
            "context": episodic,
            "documents": documents,
            "facts": facts,
            "skills": skills,
            "user_model": user_model_text,
            "skills_text": skills_text,
            "tiers": {
                "episodic_count": len(episodic),
                "document_count": len(documents),
                "fact_count": len(facts),
                "skill_count": len(skills),
            },
        }

    def get_stats(self) -> Dict[str, Any]:
        return {
            "facts": len(self.user_model.get_all_facts()),
            "skills": len(self.skill_library.get_all_skills()),
            "user_model_updated_at": self.user_model._data.get("updated_at"),
            "skill_library_updated_at": self.skill_library._data.get("updated_at"),
        }

    def incremental_index_session(
        self,
        history_store,
        session_id: str,
        history: List[Dict[str, str]],
    ) -> Dict[str, Any]:
        """Append new conversation chunks to episodic memory (Tier 2)."""
        if not history:
            return {"indexed_messages": 0, "skipped": True}

        last_count = history_store.get_indexed_message_count(session_id)
        if len(history) <= last_count:
            return {"indexed_messages": 0, "skipped": True, "reason": "already_up_to_date"}

        start = max(0, last_count - 1)
        slice_history = history[start:]
        result = self.memory.insert_history(slice_history, session_id=session_id)
        if result is None:
            return {"indexed_messages": 0, "skipped": True, "reason": "insert_failed"}

        history_store.set_indexed_message_count(session_id, len(history))
        history_store.mark_session_indexed(session_id, True)
        return {
            "indexed_messages": len(slice_history),
            "total_messages": len(history),
            "skipped": False,
        }

    def full_reindex_session(
        self,
        history_store,
        session_id: str,
        history: List[Dict[str, str]],
        *,
        window_size: int = 3,
        stride: int = 1,
        format_style: str = "simple",
    ) -> Dict[str, Any]:
        self.memory.delete_session_messages(session_id)
        if not history:
            history_store.set_indexed_message_count(session_id, 0)
            history_store.mark_session_indexed(session_id, False)
            return {"indexed_messages": 0}

        result = self.memory.insert_history(
            history,
            session_id=session_id,
            window_size=window_size,
            stride=stride,
            format_style=format_style,
        )
        if result is None:
            return {"indexed_messages": 0, "error": "insert_failed"}

        history_store.set_indexed_message_count(session_id, len(history))
        history_store.mark_session_indexed(session_id, True)
        return {"indexed_messages": len(history)}
