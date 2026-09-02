import hashlib
import io
import os
import time
import traceback
from typing import Dict, List, Optional, Tuple

import mss
import numpy as np
import torch
from PIL import Image
from transformers import BlipForConditionalGeneration, BlipProcessor

from ..lib.LAV_logger import logger

try:
    import easyocr
except Exception:  # pragma: no cover
    easyocr = None


def _pick_device(preferred: str = "auto") -> str:
    if preferred == "cpu":
        return "cpu"
    if preferred == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    # auto: use CUDA when available, but keep EasyOCR/BLIP workable on 4GB cards
    if torch.cuda.is_available():
        try:
            # Leave headroom for TTS / system
            free_bytes, total_bytes = torch.cuda.mem_get_info()
            free_gb = free_bytes / (1024 ** 3)
            if free_gb >= 1.2:
                return "cuda"
            logger.warning(f"CUDA free VRAM low ({free_gb:.2f} GB); using CPU for vision")
        except Exception:
            return "cuda"
    return "cpu"


class VisionInput:
    """
    Screen capture + OCR-first vision pipeline with caching and change detection.
    """

    CHANGE_THRESHOLD = 4.5  # mean absolute diff on 64x64 grayscale
    DEFAULT_OCR_SCALE = 0.65
    DEFAULT_JPEG_QUALITY = 72
    DEFAULT_PREVIEW_MAX_WIDTH = 1280
    DEFAULT_LLM_IMAGE_MAX_WIDTH = 1024
    MAX_OCR_CHARS = 1600

    def __init__(self, languages: Optional[List[str]] = None, device: str = "auto"):
        languages = languages or ["en"]
        self.device = _pick_device(device)
        self.logger = logger
        self.languages = languages

        self._last_hash: Optional[str] = None
        self._last_fingerprint: Optional[np.ndarray] = None
        self._last_monitor: Optional[int] = None
        self._cached_result: Optional[Dict] = None

        self.ocr_reader = None
        self.processor = None
        self.model = None

        if easyocr is not None:
            try:
                gpu = self.device == "cuda"
                self.ocr_reader = easyocr.Reader(languages, gpu=gpu)
                self.logger.info(f"OCR reader initialized (languages={languages}, gpu={gpu})")
            except Exception as e:
                self.logger.error(f"Failed to initialize OCR reader: {e}")
                self.ocr_reader = None
        else:
            self.logger.error("easyocr is not installed")

        try:
            self.processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
            self.model = BlipForConditionalGeneration.from_pretrained(
                "Salesforce/blip-image-captioning-base"
            )
            if self.device == "cuda":
                self.model = self.model.to("cuda")
            self.logger.info(f"BLIP caption model initialized on {self.device}")
        except Exception as e:
            self.logger.error(f"Failed to initialize image captioning model: {e}")
            self.processor = None
            self.model = None

    def get_monitors(self) -> List[Dict]:
        try:
            with mss.mss() as sct:
                monitors = sct.monitors
                enriched = []
                for index, monitor in enumerate(monitors):
                    enriched.append({
                        **monitor,
                        "index": index,
                        "is_primary": index == 1,
                        "description": (
                            "All monitors" if index == 0
                            else f"Monitor {index} ({monitor.get('width')}x{monitor.get('height')})"
                        ),
                    })
                return enriched
        except Exception as e:
            self.logger.error(f"Failed to get monitors: {e}, {traceback.format_exc()}")
            return []

    def capture_screenshot(self, monitor_index: int = 1, save_path: Optional[str] = None) -> Optional[Image.Image]:
        try:
            with mss.mss() as sct:
                monitors = sct.monitors
                if monitor_index < 0 or monitor_index >= len(monitors):
                    monitor_index = 1 if len(monitors) > 1 else 0
                screenshot = sct.grab(monitors[monitor_index])
                img = Image.frombytes("RGB", (screenshot.width, screenshot.height), screenshot.rgb)
                if save_path:
                    img.save(save_path)
                return img
        except Exception as e:
            self.logger.error(f"Failed to capture screenshot: {e}")
            return None

    @staticmethod
    def resize_image(image: Image.Image, max_width: int) -> Image.Image:
        if max_width <= 0 or image.width <= max_width:
            return image
        ratio = max_width / float(image.width)
        height = max(1, int(image.height * ratio))
        return image.resize((max_width, height), Image.Resampling.BILINEAR)

    @staticmethod
    def encode_jpeg_base64(image: Image.Image, quality: int = 72, max_width: int = 1280) -> str:
        import base64

        resized = VisionInput.resize_image(image, max_width)
        if resized.mode != "RGB":
            resized = resized.convert("RGB")
        buffer = io.BytesIO()
        resized.save(buffer, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")

    @staticmethod
    def _fingerprint(image: Image.Image) -> np.ndarray:
        tiny = image.convert("L").resize((64, 64), Image.Resampling.BILINEAR)
        return np.asarray(tiny, dtype=np.float32)

    @staticmethod
    def _hash_image(image: Image.Image) -> str:
        tiny = image.convert("L").resize((32, 32), Image.Resampling.BILINEAR)
        return hashlib.md5(tiny.tobytes()).hexdigest()

    def has_significant_change(self, image: Image.Image, monitor_index: int) -> bool:
        fingerprint = self._fingerprint(image)
        if self._last_fingerprint is None or self._last_monitor != monitor_index:
            return True
        diff = float(np.mean(np.abs(fingerprint - self._last_fingerprint)))
        return diff >= self.CHANGE_THRESHOLD

    def perform_ocr(
        self,
        image: Image.Image,
        confidence_threshold: float = 0.35,
        scale_factor: float = 0.65,
    ) -> List[Dict]:
        if self.ocr_reader is None:
            self.logger.error("OCR reader not initialized")
            return []

        try:
            original_size = image.size
            if scale_factor != 1.0:
                new_width = max(1, int(original_size[0] * scale_factor))
                new_height = max(1, int(original_size[1] * scale_factor))
                scaled_image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            else:
                scaled_image = image

            image_array = np.array(scaled_image)
            # paragraph=False keeps more granular text; detail=1 returns boxes
            results = self.ocr_reader.readtext(
                image_array,
                decoder="beamsearch",
                paragraph=False,
                min_size=8,
            )

            filtered_results = []
            for bbox, text, conf in results:
                cleaned = (text or "").strip()
                if not cleaned or conf < confidence_threshold:
                    continue
                if scale_factor != 1.0:
                    scaled_bbox = [
                        (int(point[0] / scale_factor), int(point[1] / scale_factor))
                        for point in bbox
                    ]
                    bbox = scaled_bbox
                filtered_results.append({
                    "text": cleaned,
                    "bbox": bbox,
                    "confidence": float(conf),
                })

            # Reading order: top-to-bottom, then left-to-right
            def sort_key(item: Dict):
                box = item["bbox"]
                ys = [p[1] for p in box]
                xs = [p[0] for p in box]
                return (min(ys), min(xs))

            filtered_results.sort(key=sort_key)
            self.logger.info(f"OCR completed: {len(filtered_results)} text regions")
            return filtered_results
        except Exception as e:
            self.logger.error(f"Failed to perform OCR: {e}")
            return []

    def generate_caption(self, image: Image.Image) -> Optional[str]:
        if self.processor is None or self.model is None:
            return None
        try:
            # Caption on a smaller image — enough for UI overview, much faster
            caption_image = self.resize_image(image, 640)
            if caption_image.mode != "RGB":
                caption_image = caption_image.convert("RGB")

            prompt = "a screenshot showing"
            inputs = self.processor(caption_image, prompt, return_tensors="pt")
            if self.device == "cuda":
                inputs = {k: v.to("cuda") for k, v in inputs.items()}

            with torch.inference_mode():
                out = self.model.generate(**inputs, max_new_tokens=40)

            caption = self.processor.decode(out[0], skip_special_tokens=True)
            if caption.lower().startswith(prompt.lower()):
                caption = caption[len(prompt):].strip(" :,-")
            return caption or None
        except Exception as e:
            self.logger.error(f"Failed to generate caption: {e}")
            return None

    def get_detected_text(self, ocr_results: List[Dict], max_chars: int = MAX_OCR_CHARS) -> str:
        if not ocr_results:
            return ""

        lines: List[str] = []
        current_line: List[str] = []
        last_y = None
        line_threshold = 18

        for item in ocr_results:
            text = item.get("text", "").strip()
            if not text:
                continue
            box = item.get("bbox") or [[0, 0]]
            y = min(p[1] for p in box)
            if last_y is None or abs(y - last_y) <= line_threshold:
                current_line.append(text)
            else:
                if current_line:
                    lines.append(" ".join(current_line))
                current_line = [text]
            last_y = y
        if current_line:
            lines.append(" ".join(current_line))

        # Deduplicate consecutive identical lines
        deduped: List[str] = []
        for line in lines:
            if not deduped or deduped[-1] != line:
                deduped.append(line)

        joined = "\n".join(deduped)
        if len(joined) <= max_chars:
            return joined
        return joined[: max_chars - 20].rstrip() + "\n…[truncated]"

    def process_screen(
        self,
        monitor_index: int = 1,
        save_screenshot: bool = False,
        screenshot_path: str = None,
        confidence_threshold: float = 0.35,
        ocr_scale_factor: float = DEFAULT_OCR_SCALE,
        skip_ocr: bool = False,
        skip_caption: bool = True,
        mode: str = "rich",
        force: bool = False,
        jpeg_quality: int = DEFAULT_JPEG_QUALITY,
        preview_max_width: int = DEFAULT_PREVIEW_MAX_WIDTH,
        llm_image_max_width: int = DEFAULT_LLM_IMAGE_MAX_WIDTH,
    ) -> Dict:
        """
        mode:
          - fast: capture + preview encode; reuse OCR/caption if unchanged
          - rich: OCR-first analysis (preference B), optional caption
          - auto: rich when changed/forced, otherwise cached fast response
        """
        started = time.perf_counter()
        mode = (mode or "rich").lower()
        if mode not in ("fast", "rich", "auto"):
            mode = "rich"

        result = {
            "screenshot": None,
            "ocr_results": [],
            "caption": None,
            "success": False,
            "unchanged": False,
            "mode": mode,
            "image_jpeg": "",
            "image_llm_jpeg": "",
            "extracted_text": "",
            "duration_ms": 0,
        }

        if save_screenshot and not screenshot_path:
            screenshot_path = os.path.join(os.path.dirname(__file__), "screen.jpg")

        screenshot = self.capture_screenshot(monitor_index, screenshot_path if save_screenshot else None)
        if screenshot is None:
            return result

        result["screenshot"] = screenshot
        image_hash = self._hash_image(screenshot)
        changed = force or self.has_significant_change(screenshot, monitor_index)

        # Fast path / unchanged: return cached analysis quickly
        if mode in ("fast", "auto") and not changed and self._cached_result is not None:
            cached = self._cached_result
            result.update({
                "ocr_results": cached.get("ocr_results", []),
                "caption": cached.get("caption"),
                "extracted_text": cached.get("extracted_text", ""),
                "image_jpeg": self.encode_jpeg_base64(screenshot, jpeg_quality, preview_max_width),
                "image_llm_jpeg": cached.get("image_llm_jpeg") or self.encode_jpeg_base64(
                    screenshot, jpeg_quality, llm_image_max_width
                ),
                "unchanged": True,
                "success": True,
                "mode": "cache",
                "duration_ms": int((time.perf_counter() - started) * 1000),
            })
            return result

        run_ocr = not skip_ocr and mode in ("rich", "auto")
        run_caption = not skip_caption and mode in ("rich", "auto")
        # Preference B: in auto mode prioritize OCR; caption only occasionally via skip_caption=false

        if mode == "fast":
            run_ocr = False
            run_caption = False

        ocr_results: List[Dict] = []
        if run_ocr:
            ocr_results = self.perform_ocr(
                screenshot,
                confidence_threshold=confidence_threshold,
                scale_factor=ocr_scale_factor,
            )
        elif self._cached_result and not changed:
            ocr_results = self._cached_result.get("ocr_results", [])

        caption = None
        if run_caption:
            caption = self.generate_caption(screenshot)
        elif self._cached_result and not changed:
            caption = self._cached_result.get("caption")

        extracted_text = self.get_detected_text(ocr_results)
        image_jpeg = self.encode_jpeg_base64(screenshot, jpeg_quality, preview_max_width)
        image_llm_jpeg = self.encode_jpeg_base64(screenshot, jpeg_quality, llm_image_max_width)

        result.update({
            "ocr_results": ocr_results,
            "caption": caption,
            "extracted_text": extracted_text,
            "image_jpeg": image_jpeg,
            "image_llm_jpeg": image_llm_jpeg,
            "unchanged": False,
            "success": True,
            "duration_ms": int((time.perf_counter() - started) * 1000),
        })

        self._last_hash = image_hash
        self._last_fingerprint = self._fingerprint(screenshot)
        self._last_monitor = monitor_index
        self._cached_result = {
            "ocr_results": ocr_results,
            "caption": caption,
            "extracted_text": extracted_text,
            "image_llm_jpeg": image_llm_jpeg,
        }
        self.logger.info(
            f"Screen processed mode={result['mode']} changed={changed} "
            f"ocr={len(ocr_results)} duration={result['duration_ms']}ms"
        )
        return result


if __name__ == "__main__":
    vision_input = VisionInput()
    monitors = vision_input.get_monitors()
    logger.info(f"Monitors: {monitors}")
    result = vision_input.process_screen(monitor_index=1, mode="rich", skip_caption=True)
    logger.info(f"Success={result['success']} duration={result['duration_ms']}ms")
    logger.info(f"Text: {result['extracted_text'][:300]}")
