"""Extract plain text from uploaded documents (v1: PDF, MD, TXT, images)."""

from __future__ import annotations

import io
import os
from typing import Tuple

from PIL import Image

MAX_EXTRACT_CHARS = 50_000

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
TEXT_EXTENSIONS = {".txt", ".md", ".markdown"}
PDF_EXTENSIONS = {".pdf"}


def _truncate(text: str) -> str:
    text = (text or "").strip()
    if len(text) <= MAX_EXTRACT_CHARS:
        return text
    return text[: MAX_EXTRACT_CHARS - 20].rstrip() + "\n…[truncated]"


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise RuntimeError("pypdf is not installed. Run: pip install pypdf") from e

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        page_text = page.extract_text() or ""
        if page_text.strip():
            parts.append(page_text.strip())
    return "\n\n".join(parts)


def _extract_image_ocr(data: bytes, vision_input) -> str:
    if vision_input is None:
        return "[Image uploaded — OCR unavailable. Install easyocr for text extraction.]"

    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
        results = vision_input.perform_ocr(image, confidence_threshold=0.35, scale_factor=0.85)
        text = vision_input.get_detected_text(results, max_chars=MAX_EXTRACT_CHARS)
        if text.strip():
            return text
        return "[Image uploaded — no readable text detected by OCR.]"
    except Exception as e:
        return f"[Image uploaded — OCR failed: {e}]"


def detect_kind(filename: str, mime: str = "") -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    mime = (mime or "").lower()

    if ext in PDF_EXTENSIONS or mime == "application/pdf":
        return "pdf"
    if ext in TEXT_EXTENSIONS or mime in ("text/plain", "text/markdown"):
        return "text"
    if ext in IMAGE_EXTENSIONS or mime.startswith("image/"):
        return "image"
    return "unknown"


def extract_document_text(
    data: bytes,
    filename: str,
    mime: str = "",
    vision_input=None,
) -> Tuple[str, str]:
    """
    Returns (extracted_text, kind).
    Raises ValueError for unsupported types.
    """
    kind = detect_kind(filename, mime)
    if kind == "pdf":
        return _truncate(_extract_pdf(data)), kind
    if kind == "text":
        return _truncate(_decode_text(data)), kind
    if kind == "image":
        return _truncate(_extract_image_ocr(data, vision_input)), kind
    raise ValueError(
        f"Unsupported file type: {filename}. Supported: PDF, TXT, Markdown, JPEG, PNG, WebP."
    )
