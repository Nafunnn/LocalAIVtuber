import base64
import os
import re
from typing import Generator, List, Dict

from ollama import Client
from ollama import ResponseError

from services.lib.LAV_logger import logger
from .BaseLLM import BaseLLM


def _normalize_image_value(image) -> str | None:
    """Convert data URLs / dict payloads into raw base64 for Ollama Cloud."""
    if image is None:
        return None
    if isinstance(image, dict):
        for key in ("data", "base64", "image", "content"):
            if image.get(key):
                return _normalize_image_value(image[key])
        return None

    value = str(image).strip()
    if not value:
        return None
    if value.startswith("data:"):
        parts = value.split(",", 1)
        value = parts[1] if len(parts) > 1 else ""
    value = re.sub(r"\s+", "", value.strip())
    if not value:
        return None
    try:
        base64.b64decode(value, validate=True)
    except Exception:
        return None
    return value


def _normalize_message(message: Dict) -> Dict:
    copy = dict(message)
    raw_images = copy.get("images")
    if not raw_images:
        copy.pop("images", None)
        return copy

    cleaned: List[str] = []
    for image in raw_images:
        normalized = _normalize_image_value(image)
        if normalized:
            cleaned.append(normalized)
    if cleaned:
        copy["images"] = cleaned
    else:
        copy.pop("images", None)
    return copy


def _normalize_messages(messages: List[Dict]) -> List[Dict]:
    normalized: List[Dict] = []
    for message in messages:
        if isinstance(message, dict):
            normalized.append(_normalize_message(message))
        else:
            normalized.append(message)
    return normalized


def _strip_images_from_messages(messages: List[Dict]) -> List[Dict]:
    stripped: List[Dict] = []
    for message in messages:
        if not isinstance(message, dict):
            stripped.append(message)
            continue
        copy = dict(message)
        copy.pop("images", None)
        stripped.append(copy)
    return stripped


def _messages_have_images(messages: List[Dict]) -> bool:
    return any(isinstance(m, dict) and m.get("images") for m in messages)


class OllamaCloudLLM(BaseLLM):
    def __init__(self, model: str, base_url: str = "https://ollama.com"):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._client = None

    def _get_api_key(self) -> str:
        api_key = os.environ.get("OLLAMA_API_KEY", "").strip()
        if not api_key:
            raise ValueError("OLLAMA_API_KEY environment variable is not set")
        return api_key

    def _get_client(self) -> Client:
        if self._client is None:
            self._client = Client(
                host=self.base_url,
                headers={"Authorization": f"Bearer {self._get_api_key()}"},
            )
        return self._client

    def _build_options(self, **sampling_params) -> dict:
        options = {}
        if "temperature" in sampling_params:
            options["temperature"] = sampling_params["temperature"]
        if "top_k" in sampling_params:
            options["top_k"] = sampling_params["top_k"]
        if "top_p" in sampling_params:
            options["top_p"] = sampling_params["top_p"]
        if "repeat_penalty" in sampling_params:
            options["repeat_penalty"] = sampling_params["repeat_penalty"]
        if "min_p" in sampling_params:
            options["min_p"] = sampling_params["min_p"]
        seed = sampling_params.get("seed", -1)
        if seed is not None and seed != -1:
            options["seed"] = seed
        return options

    def _build_messages(
        self,
        text: str,
        history: list,
        system_prompt: str,
        images: list | None = None,
    ) -> List[Dict]:
        messages: List[Dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            for entry in history:
                if isinstance(entry, dict):
                    messages.append(_normalize_message(entry))
                else:
                    messages.append(entry)

        user_message: Dict = {"role": "user", "content": text}
        if images:
            cleaned = []
            for image in images:
                normalized = _normalize_image_value(image)
                if normalized:
                    cleaned.append(normalized)
            if cleaned:
                user_message["images"] = cleaned
        messages.append(user_message)
        return messages

    def _stream_chat(
        self,
        messages: List[Dict],
        options: dict,
        *,
        allow_image_fallback: bool = True,
    ) -> Generator[str, None, None]:
        try:
            client = self._get_client()
            for part in client.chat(
                model=self.model,
                messages=messages,
                stream=True,
                options=options,
            ):
                content = part.get("message", {}).get("content")
                if content:
                    yield content
        except ResponseError as e:
            status = getattr(e, "status_code", None)
            if status == 401:
                raise ValueError("Invalid or missing Ollama API key") from e
            if status == 404:
                raise ValueError(f"Model '{self.model}' not found on Ollama Cloud") from e
            # Vision-capable request on a text-only model: retry without images once.
            if allow_image_fallback and _messages_have_images(messages):
                logger.warning(
                    f"Ollama Cloud rejected multimodal request ({e}); retrying without images"
                )
                yield from self._stream_chat(
                    _strip_images_from_messages(messages),
                    options,
                    allow_image_fallback=False,
                )
                return
            raise ValueError(f"Ollama Cloud error: {e}") from e
        except ValueError:
            raise
        except Exception as e:
            if allow_image_fallback and _messages_have_images(messages):
                logger.warning(
                    f"Ollama Cloud multimodal failed ({e}); retrying without images"
                )
                yield from self._stream_chat(
                    _strip_images_from_messages(messages),
                    options,
                    allow_image_fallback=False,
                )
                return
            raise ValueError(f"Failed to connect to Ollama Cloud: {e}") from e

    def chat_with_tools(
        self,
        messages: List[Dict],
        tools: list,
        options: dict | None = None,
        *,
        allow_image_fallback: bool = True,
    ):
        """Non-streaming chat that can return tool_calls (for agent loops)."""
        client = self._get_client()
        normalized = _normalize_messages(messages)
        try:
            response = client.chat(
                model=self.model,
                messages=normalized,
                tools=tools,
                stream=False,
                options=options or {},
            )
            return response
        except ResponseError as e:
            status = getattr(e, "status_code", None)
            if status == 401:
                raise ValueError("Invalid or missing Ollama API key") from e
            if status == 404:
                raise ValueError(f"Model '{self.model}' not found on Ollama Cloud") from e
            if allow_image_fallback and _messages_have_images(normalized):
                logger.warning(
                    f"Ollama Cloud rejected tool request with images ({e}); "
                    "retrying without images"
                )
                return self.chat_with_tools(
                    _strip_images_from_messages(normalized),
                    tools,
                    options,
                    allow_image_fallback=False,
                )
            raise ValueError(f"Ollama Cloud error: {e}") from e
        except ValueError:
            raise
        except Exception as e:
            if allow_image_fallback and _messages_have_images(normalized):
                logger.warning(
                    f"Ollama Cloud tool request with images failed ({e}); "
                    "retrying without images"
                )
                return self.chat_with_tools(
                    _strip_images_from_messages(normalized),
                    tools,
                    options,
                    allow_image_fallback=False,
                )
            raise ValueError(f"Failed to connect to Ollama Cloud: {e}") from e

    def get_chat_completion(
        self,
        text: str,
        history: list = [],
        system_prompt: str = "",
        images: list | None = None,
        **sampling_params,
    ) -> Generator[str, None, None]:
        messages = self._build_messages(text, history, system_prompt, images=images)
        options = self._build_options(**sampling_params)
        logger.info(
            f"Ollama Cloud inference - model: {self.model}, options: {options}, "
            f"images={len(images) if images else 0}"
        )
        yield from self._stream_chat(messages, options)

    def complete_current_response(
        self,
        history: List[Dict[str, str]],
        system_prompt: str = "",
        **sampling_params,
    ) -> Generator[str, None, None]:
        if not history:
            logger.warning("No history provided to complete")
            return

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.extend(history)

        options = self._build_options(**sampling_params)
        logger.info(
            f"Ollama Cloud complete response - model: {self.model}, options: {options}"
        )
        yield from self._stream_chat(messages, options)
