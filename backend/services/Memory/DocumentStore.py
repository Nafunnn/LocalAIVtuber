"""Filesystem metadata store for uploaded knowledge-base documents."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional


def _sanitize_filename(name: str) -> str:
    base = os.path.basename(name or "document")
    base = re.sub(r"[^\w.\- ()]", "_", base)
    return base[:180] or "document"


class DocumentStore:
    def __init__(
        self,
        files_dir_name: str = "document_files",
        registry_name: str = "documents_registry.json",
    ):
        root = os.path.dirname(__file__)
        self.files_dir = os.path.join(root, files_dir_name)
        self.registry_path = os.path.join(root, registry_name)
        os.makedirs(self.files_dir, exist_ok=True)
        self._ensure_registry()

    def _ensure_registry(self) -> None:
        if not os.path.isfile(self.registry_path):
            self._write_registry([])

    def _read_registry(self) -> List[Dict[str, Any]]:
        try:
            with open(self.registry_path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _write_registry(self, docs: List[Dict[str, Any]]) -> None:
        with open(self.registry_path, "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False, indent=2)

    def _file_path(self, doc_id: str, filename: str) -> str:
        safe = _sanitize_filename(filename)
        return os.path.join(self.files_dir, f"{doc_id}_{safe}")

    def create_document(
        self,
        filename: str,
        mime: str,
        data: bytes,
    ) -> Dict[str, Any]:
        doc_id = str(uuid.uuid4())
        path = self._file_path(doc_id, filename)
        with open(path, "wb") as f:
            f.write(data)

        record = {
            "id": doc_id,
            "filename": _sanitize_filename(filename),
            "mime": mime or "application/octet-stream",
            "size": len(data),
            "created_at": datetime.now().isoformat(),
            "indexed": False,
            "indexed_at": None,
            "char_count": 0,
            "kind": "",
            "error": None,
            "storage_path": path,
        }
        docs = self._read_registry()
        docs.insert(0, record)
        self._write_registry(docs)
        return record

    def list_documents(self) -> List[Dict[str, Any]]:
        docs = self._read_registry()
        public = []
        for doc in docs:
            public.append(
                {
                    "id": doc.get("id"),
                    "filename": doc.get("filename"),
                    "mime": doc.get("mime"),
                    "size": doc.get("size"),
                    "created_at": doc.get("created_at"),
                    "indexed": bool(doc.get("indexed")),
                    "indexed_at": doc.get("indexed_at"),
                    "char_count": doc.get("char_count", 0),
                    "kind": doc.get("kind", ""),
                    "error": doc.get("error"),
                }
            )
        return public

    def get_document(self, doc_id: str) -> Optional[Dict[str, Any]]:
        for doc in self._read_registry():
            if doc.get("id") == doc_id:
                return dict(doc)
        return None

    def read_file_bytes(self, doc_id: str) -> Optional[bytes]:
        doc = self.get_document(doc_id)
        if not doc:
            return None
        path = doc.get("storage_path")
        if not path or not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            return f.read()

    def update_document(self, doc_id: str, **fields) -> bool:
        docs = self._read_registry()
        updated = False
        for doc in docs:
            if doc.get("id") == doc_id:
                doc.update(fields)
                updated = True
                break
        if updated:
            self._write_registry(docs)
        return updated

    def delete_document(self, doc_id: str) -> bool:
        docs = self._read_registry()
        target = None
        remaining = []
        for doc in docs:
            if doc.get("id") == doc_id:
                target = doc
            else:
                remaining.append(doc)
        if not target:
            return False
        path = target.get("storage_path")
        if path and os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
        self._write_registry(remaining)
        return True
