"""Ollama + MCP tool-calling agent loop for Spotify."""

from __future__ import annotations

from typing import Any, Dict, Generator, List, Optional

from services.lib.LAV_logger import logger
from .schemas import mcp_tools_to_ollama, normalize_tool_arguments
from .spotify_client import SPOTIFY_SYSTEM_HINT, SpotifyMCPClient


MAX_TOOL_ROUNDS = 8

_MUSIC_INTENT_KEYWORDS = (
    "spotify",
    "play ",
    "play\t",
    "pause",
    "skip",
    "playlist",
    "volume",
    "song",
    "music",
    "track",
    "queue",
    "what's playing",
    "what is playing",
    "now playing",
)


def _looks_like_music_request(text: str) -> bool:
    lowered = (text or "").lower()
    return any(k in lowered for k in _MUSIC_INTENT_KEYWORDS)


def _message_to_dict(message: Any) -> Dict[str, Any]:
    """Normalize an Ollama Message / mapping into a plain dict for the next chat turn."""
    if isinstance(message, dict):
        out = dict(message)
    else:
        out = {
            "role": getattr(message, "role", "assistant"),
            "content": getattr(message, "content", None) or "",
        }
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls:
            serialized = []
            for call in tool_calls:
                if isinstance(call, dict):
                    serialized.append(call)
                    continue
                fn = getattr(call, "function", None)
                if fn is None and isinstance(call, dict):
                    fn = call.get("function")
                if isinstance(fn, dict):
                    name = fn.get("name")
                    arguments = fn.get("arguments") or {}
                else:
                    name = getattr(fn, "name", None)
                    arguments = getattr(fn, "arguments", None) or {}
                serialized.append(
                    {
                        "type": getattr(call, "type", "function") or "function",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        },
                    }
                )
            out["tool_calls"] = serialized
    if out.get("content") is None:
        out["content"] = ""
    return out


def _extract_tool_calls(message: Any) -> List[Any]:
    if isinstance(message, dict):
        return list(message.get("tool_calls") or [])
    return list(getattr(message, "tool_calls", None) or [])


def _tool_call_parts(call: Any) -> tuple[str, Dict[str, Any]]:
    if isinstance(call, dict):
        fn = call.get("function") or {}
        name = fn.get("name") or ""
        arguments = fn.get("arguments") or {}
    else:
        fn = getattr(call, "function", None)
        name = getattr(fn, "name", "") if fn is not None else ""
        arguments = getattr(fn, "arguments", None) if fn is not None else {}
    if not isinstance(arguments, dict):
        # Some SDKs return JSON strings
        import json

        try:
            arguments = json.loads(arguments) if arguments else {}
        except (TypeError, json.JSONDecodeError):
            arguments = {}
    return name, arguments


class SpotifyToolAgent:
    """Run non-streaming tool rounds, then stream the final natural-language reply."""

    def __init__(self, ollama_llm, mcp_client: SpotifyMCPClient):
        self.ollama_llm = ollama_llm
        self.mcp = mcp_client

    def run(
        self,
        text: str,
        history: list,
        system_prompt: str,
        images: list | None = None,
        **sampling_params,
    ) -> Generator[str, None, None]:
        try:
            mcp_tools = self.mcp.get_tools()
        except Exception as e:
            logger.error(f"Spotify MCP unavailable; falling back to plain chat: {e}")
            yield from self.ollama_llm.get_chat_completion(
                text, history, system_prompt, images=images, **sampling_params
            )
            return

        ollama_tools = mcp_tools_to_ollama(mcp_tools)
        if not ollama_tools:
            logger.warning("Spotify MCP returned no tools; falling back to plain chat")
            yield from self.ollama_llm.get_chat_completion(
                text, history, system_prompt, images=images, **sampling_params
            )
            return

        augmented_system = system_prompt or ""
        if SPOTIFY_SYSTEM_HINT not in augmented_system:
            augmented_system = (
                f"{augmented_system}\n\n{SPOTIFY_SYSTEM_HINT}".strip()
                if augmented_system
                else SPOTIFY_SYSTEM_HINT
            )

        messages = self.ollama_llm._build_messages(
            text, history, augmented_system, images=images
        )
        options = self.ollama_llm._build_options(**sampling_params)
        music_intent = _looks_like_music_request(text)
        # Log once that schemas actually have properties (guards against empty schemas).
        sample = next(
            (t for t in ollama_tools if t["function"]["name"] == "searchSpotify"),
            None,
        )
        if sample:
            props = (sample["function"].get("parameters") or {}).get("properties") or {}
            logger.info(
                f"Spotify tool schemas ready (searchSpotify props={list(props.keys())})"
            )

        final_content = ""
        nudged_for_tools = False
        for round_idx in range(MAX_TOOL_ROUNDS):
            logger.info(
                f"Spotify tool agent round {round_idx + 1}/{MAX_TOOL_ROUNDS} "
                f"(tools={len(ollama_tools)})"
            )
            try:
                response = self.ollama_llm.chat_with_tools(
                    messages, tools=ollama_tools, options=options
                )
            except Exception as e:
                logger.error(f"Ollama tool chat failed: {e}")
                if round_idx == 0:
                    yield from self.ollama_llm.get_chat_completion(
                        text, history, system_prompt, images=images, **sampling_params
                    )
                    return
                break

            message = getattr(response, "message", None) or response.get("message")
            if message is None:
                break

            tool_calls = _extract_tool_calls(message)
            msg_dict = _message_to_dict(message)

            if not tool_calls:
                final_content = msg_dict.get("content") or ""
                # Model skipped tools on a clear music request — nudge once.
                if music_intent and not nudged_for_tools and round_idx == 0:
                    nudged_for_tools = True
                    logger.warning(
                        "Music request but model returned no tool_calls; nudging once"
                    )
                    messages.append(msg_dict)
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "You must use Spotify tools for this request. "
                                "Call searchSpotify and/or playMusic (or the right "
                                "playback tool) now. Do not pretend music is playing."
                            ),
                        }
                    )
                    final_content = ""
                    continue
                messages.append(msg_dict)
                break

            messages.append(msg_dict)

            for call in tool_calls:
                name, arguments = _tool_call_parts(call)
                arguments = normalize_tool_arguments(name, arguments)
                if not name:
                    result_text = "Error: missing tool name"
                else:
                    logger.info(f"Calling Spotify MCP tool: {name}({arguments})")
                    try:
                        result_text = self.mcp.call_tool(name, arguments)
                    except Exception as e:
                        result_text = f"Error calling {name}: {e}"
                    preview = result_text.replace("\n", " ")[:240]
                    logger.info(f"Spotify MCP result [{name}]: {preview}")
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": name or "unknown",
                        "content": result_text,
                    }
                )
        else:
            logger.warning("Spotify tool agent hit max rounds without a final reply")
            final_content = final_content or (
                "I tried to use Spotify but needed too many steps. "
                "Want me to try a simpler request?"
            )

        if not final_content:
            # One more streaming pass without tools for a spoken reply
            yield from self.ollama_llm._stream_chat(messages, options)
            return

        yield final_content
