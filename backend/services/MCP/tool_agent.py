"""Ollama + MCP tool-calling agent loop (multi-MCP)."""

from __future__ import annotations

from typing import Any, Dict, Generator, List, Optional

from services.lib.LAV_logger import logger
from .registry import MCPRegistry
from .schemas import mcp_tools_to_ollama, normalize_tool_arguments


MAX_TOOL_ROUNDS = 14

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

_BROWSER_INTENT_KEYWORDS = (
    "google",
    "search",
    "browse",
    "browser",
    "website",
    "web ",
    "open http",
    "open www",
    "navigate",
    "look up",
    "lookup",
    "find online",
    "youtube.com",
    "wikipedia",
    "tab ",
    "page ",
    "url ",
    "http://",
    "https://",
)


def _looks_like_music_request(text: str) -> bool:
    lowered = (text or "").lower()
    return any(k in lowered for k in _MUSIC_INTENT_KEYWORDS)


def _looks_like_browser_request(text: str) -> bool:
    lowered = (text or "").lower()
    return any(k in lowered for k in _BROWSER_INTENT_KEYWORDS)


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
        import json

        try:
            arguments = json.loads(arguments) if arguments else {}
        except (TypeError, json.JSONDecodeError):
            arguments = {}
    return name, arguments


def _build_nudge(text: str, registry: MCPRegistry) -> str | None:
    music = _looks_like_music_request(text)
    browser = _looks_like_browser_request(text)
    from .spotify_client import spotify_mcp
    from .browser_client import browser_mcp

    if music and spotify_mcp.enabled and not browser:
        return (
            "You must use Spotify tools for this request. "
            "Call searchSpotify and/or playMusic (or the right playback tool) now. "
            "Do not pretend music is playing."
        )
    if browser and browser_mcp.enabled and not music:
        return (
            "You must use browser tools for this request. "
            "Start with browser_navigate or browser_snapshot as appropriate. "
            "Do not pretend you searched the web without tool results."
        )
    if music and browser:
        parts = []
        if spotify_mcp.enabled:
            parts.append("Use Spotify tools for music actions.")
        if browser_mcp.enabled:
            parts.append("Use browser tools for web/search actions.")
        if parts:
            return " ".join(parts) + " Do not claim success without tool results."
    return None


class MCPToolAgent:
    """Run non-streaming tool rounds, then stream the final natural-language reply."""

    def __init__(self, ollama_llm, registry: MCPRegistry):
        self.ollama_llm = ollama_llm
        self.registry = registry

    def run(
        self,
        text: str,
        history: list,
        system_prompt: str,
        images: list | None = None,
        **sampling_params,
    ) -> Generator[str, None, None]:
        try:
            mcp_tools = self.registry.get_all_tools()
        except Exception as e:
            logger.error(f"MCP unavailable; falling back to plain chat: {e}")
            yield from self.ollama_llm.get_chat_completion(
                text, history, system_prompt, images=images, **sampling_params
            )
            return

        ollama_tools = mcp_tools_to_ollama(mcp_tools)
        if not ollama_tools:
            logger.warning("MCP returned no tools; falling back to plain chat")
            yield from self.ollama_llm.get_chat_completion(
                text, history, system_prompt, images=images, **sampling_params
            )
            return

        augmented_system = system_prompt or ""
        for hint in self.registry.get_system_hints():
            if hint not in augmented_system:
                augmented_system = (
                    f"{augmented_system}\n\n{hint}".strip()
                    if augmented_system
                    else hint
                )

        messages = self.ollama_llm._build_messages(
            text, history, augmented_system, images=images
        )
        options = self.ollama_llm._build_options(**sampling_params)
        tool_intent = _looks_like_music_request(text) or _looks_like_browser_request(text)
        if _looks_like_browser_request(text):
            from .browser_client import browser_mcp

            if browser_mcp.enabled:
                browser_mcp.mark_tool_activity()
        logger.info(f"MCP tool agent starting with {len(ollama_tools)} tools")

        final_content = ""
        nudged_for_tools = False
        for round_idx in range(MAX_TOOL_ROUNDS):
            logger.info(
                f"MCP tool agent round {round_idx + 1}/{MAX_TOOL_ROUNDS} "
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
                nudge = _build_nudge(text, self.registry) if tool_intent else None
                if nudge and not nudged_for_tools and round_idx == 0:
                    nudged_for_tools = True
                    logger.warning("Tool intent detected but model returned no tool_calls; nudging once")
                    messages.append(msg_dict)
                    messages.append({"role": "user", "content": nudge})
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
                    logger.info(f"Calling MCP tool: {name}({arguments})")
                    try:
                        result_text = self.registry.call_tool(name, arguments)
                    except Exception as e:
                        result_text = f"Error calling {name}: {e}"
                    preview = result_text.replace("\n", " ")[:240]
                    logger.info(f"MCP result [{name}]: {preview}")
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": name or "unknown",
                        "content": result_text,
                    }
                )
        else:
            logger.warning("MCP tool agent hit max rounds without a final reply")
            final_content = final_content or (
                "I tried to use my tools but needed too many steps. "
                "Want me to try a simpler request?"
            )

        if not final_content:
            yield from self.ollama_llm._stream_chat(messages, options)
            return

        yield final_content


# Backward-compatible alias
SpotifyToolAgent = MCPToolAgent
