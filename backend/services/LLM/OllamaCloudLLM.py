import os
from typing import Generator, List, Dict

from ollama import Client
from ollama import ResponseError

from services.lib.LAV_logger import logger
from .BaseLLM import BaseLLM


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

    def _build_messages(self, text: str, history: list, system_prompt: str) -> List[Dict[str, str]]:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if history:
            for entry in history:
                messages.append(entry)
        messages.append({"role": "user", "content": text})
        return messages

    def _stream_chat(self, messages: List[Dict[str, str]], options: dict) -> Generator[str, None, None]:
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
            raise ValueError(f"Ollama Cloud error: {e}") from e
        except ValueError:
            raise
        except Exception as e:
            raise ValueError(f"Failed to connect to Ollama Cloud: {e}") from e

    def get_chat_completion(
        self,
        text: str,
        history: list = [],
        system_prompt: str = "",
        **sampling_params,
    ) -> Generator[str, None, None]:
        messages = self._build_messages(text, history, system_prompt)
        options = self._build_options(**sampling_params)
        logger.info(
            f"Ollama Cloud inference - model: {self.model}, options: {options}"
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
