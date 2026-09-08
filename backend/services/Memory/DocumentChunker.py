"""Split extracted document text into overlapping chunks for vector indexing."""

from __future__ import annotations

from typing import Any, Dict, List


class DocumentChunker:
    def __init__(self, chunk_size: int = 700, overlap: int = 80):
        self.chunk_size = max(200, chunk_size)
        self.overlap = max(0, min(overlap, chunk_size // 2))

    def chunk_text(
        self,
        text: str,
        doc_id: str,
        filename: str,
        mime: str = "",
    ) -> List[Dict[str, Any]]:
        cleaned = (text or "").strip()
        if not cleaned:
            return []

        chunks: List[Dict[str, Any]] = []
        start = 0
        length = len(cleaned)
        index = 0

        while start < length:
            end = min(start + self.chunk_size, length)
            if end < length:
                # Prefer breaking on paragraph or sentence boundary
                window = cleaned[start:end]
                break_at = max(window.rfind("\n\n"), window.rfind(". "), window.rfind(" "))
                if break_at > self.chunk_size * 0.5:
                    end = start + break_at + 1

            piece = cleaned[start:end].strip()
            if piece:
                chunks.append(
                    {
                        "text": piece,
                        "metadata": {
                            "doc_id": doc_id,
                            "filename": filename,
                            "mime": mime,
                            "chunk_index": index,
                        },
                    }
                )
                index += 1

            if end >= length:
                break
            start = max(end - self.overlap, start + 1)

        total = len(chunks)
        for chunk in chunks:
            chunk["metadata"]["total_chunks"] = total
        return chunks
