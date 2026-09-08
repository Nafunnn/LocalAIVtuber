"""Ollama + MCP tool-calling agent loop (multi-MCP)."""

from __future__ import annotations

import re
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
    "jeda",
    "hentikan",
    "matikan",
    "stop music",
    "stop spotify",
    "skip",
    "playlist",
    "volume",
    "song",
    "music",
    "lagu",
    "track",
    "queue",
    "what's playing",
    "what is playing",
    "now playing",
    "sedang diputar",
)

_PLAYBACK_TOOL_ALIASES = {
    "pause": "pausePlayback",
    "stop": "pausePlayback",
    "stopPlayback": "pausePlayback",
    "resume": "resumePlayback",
    "unpause": "resumePlayback",
    "play": "playMusic",
    "skip": "skipToNext",
    "next": "skipToNext",
    "previous": "skipToPrevious",
    "prev": "skipToPrevious",
}

_GENERIC_PLAY_PHRASES = (
    "play spotify",
    "play music",
    "play the music",
    "start spotify",
    "start music",
    "putar spotify",
    "putar musik",
    "try again to play",
    "coba lagi play",
    "coba putar lagi",
    "play again",
)

_SUCCESS_CLAIM_MARKERS = (
    "paused",
    "pause",
    "stopped",
    "berhenti",
    "sudah pause",
    "sudah di-pause",
    "sudah dijeda",
    "playing now",
    "now playing",
    "sedang diputar",
    "skipped",
    "started your spotify",
    "started spotify",
    "music going",
    "music playing",
    "get your music playing",
    "let the music",
    "coming right up",
    "started playing",
    "sudah play",
    "sudah diputar",
    "mulai putar",
)

_TRACK_QUERY_RE = re.compile(
    r"(?is)^(?:please\s+|tolong\s+)?(?:(?:can|could)\s+you\s+)?"
    r"(?:play|putar|mainkan)\s+(?:the\s+)?(?:song\s+|lagu\s+|track\s+)?"
    r"(.+?)(?:\s+(?:on|di)\s+spotify)?\.?\s*$"
)

_GENERIC_TITLES = frozenset(
    {
        "spotify",
        "music",
        "musik",
        "the music",
        "again",
        "lagu",
        "song",
        "track",
        "a song",
        "some music",
    }
)


def _extract_track_query(text: str) -> str | None:
    raw = (text or "").strip()
    if not raw:
        return None
    if _is_generic_play_request(raw) or _is_pause_request(raw):
        return None
    if _is_skip_next_request(raw) or _is_skip_previous_request(raw):
        return None
    match = _TRACK_QUERY_RE.match(raw)
    if not match:
        return None
    title = match.group(1).strip().strip("\"'")
    if not title or title.lower() in _GENERIC_TITLES or len(title) < 2:
        return None
    return title


def _parse_first_track_id(search_result: str) -> str | None:
    found = re.search(r"- ID: (\w+)\s*$", search_result or "", re.MULTILINE)
    return found.group(1) if found else None


def _append_tool_exchange(
    messages: list,
    tools_called: set[str],
    tool_name: str,
    tool_args: dict,
    result_text: str,
) -> None:
    tools_called.add(tool_name)
    messages.append(
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": tool_args,
                    },
                }
            ],
        }
    )
    messages.append(
        {
            "role": "tool",
            "tool_name": tool_name,
            "content": result_text,
        }
    )


def _auto_play_track(
    registry: MCPRegistry,
    messages: list,
    tools_called: set[str],
    query: str,
) -> None:
    search_args = {"query": query, "type": "track", "limit": 1}
    search_result = registry.call_tool("searchSpotify", search_args)
    _append_tool_exchange(
        messages, tools_called, "searchSpotify", search_args, search_result
    )
    logger.info(
        "Auto searchSpotify for track request: "
        f"{search_result.replace(chr(10), ' ')[:240]}"
    )

    track_id = _parse_first_track_id(search_result)
    if not track_id:
        logger.warning(f"No track found for query: {query}")
        return

    play_args = {"uri": f"spotify:track:{track_id}"}
    play_result = registry.call_tool("playMusic", play_args)
    _append_tool_exchange(messages, tools_called, "playMusic", play_args, play_result)
    logger.info(
        "Auto playMusic for track request: "
        f"{play_result.replace(chr(10), ' ')[:240]}"
    )


def _is_generic_play_request(text: str) -> bool:
    lowered = (text or "").lower().strip()
    if any(p in lowered for p in _GENERIC_PLAY_PHRASES):
        return True
    if "spotify" in lowered and "play" in lowered:
        if any(k in lowered for k in ("pause", "stop", "jeda", "skip", "search", "find", "what")):
            return False
        if "play spotify" in lowered or "play music" in lowered:
            return True
    return False


def _is_pause_request(text: str) -> bool:
    lowered = (text or "").lower()
    if "unpause" in lowered:
        return False
    return any(
        k in lowered
        for k in (
            "pause",
            "jeda",
            "hentikan",
            "matikan",
            "stop music",
            "stop spotify",
            "stop the music",
            "stop the song",
        )
    )


def _is_skip_next_request(text: str) -> bool:
    lowered = (text or "").lower()
    return any(
        k in lowered
        for k in (
            "skip",
            "next track",
            "next song",
            "lagu berikutnya",
            "lagu selanjutnya",
            "skip lagu",
            "lewati",
            "lewati lagu",
        )
    )


def _is_skip_previous_request(text: str) -> bool:
    lowered = (text or "").lower()
    return any(
        k in lowered
        for k in ("previous", "last track", "lagu sebelumnya", "prev song")
    )


def _playback_auto_tool(text: str) -> tuple[str, dict] | None:
    if _is_generic_play_request(text):
        return ("resumePlayback", {})
    if _is_pause_request(text):
        return ("pausePlayback", {})
    if _is_skip_previous_request(text):
        return ("skipToPrevious", {})
    if _is_skip_next_request(text):
        return ("skipToNext", {})
    return None


def _required_spotify_tools(text: str) -> set[str]:
    track_query = _extract_track_query(text)
    if track_query:
        return {"searchSpotify", "playMusic"}
    if _is_pause_request(text):
        return {"pausePlayback"}
    if any(
        k in (text or "").lower()
        for k in ("resume", "lanjutkan", "unpause", "continue music", "putar lagi")
    ):
        return {"resumePlayback", "playMusic"}
    if _is_generic_play_request(text):
        return {"resumePlayback", "playMusic"}
    if _is_skip_previous_request(text):
        return {"skipToPrevious"}
    if _is_skip_next_request(text):
        return {"skipToNext"}
    return set()


def _claims_playback_success_without_tools(
    content: str, tools_called: set[str], user_text: str
) -> bool:
    track_query = _extract_track_query(user_text)
    if track_query and "playMusic" not in tools_called:
        lowered = (content or "").lower()
        return any(marker in lowered for marker in _SUCCESS_CLAIM_MARKERS)
    required = _required_spotify_tools(user_text)
    if not required or required.intersection(tools_called):
        return False
    lowered = (content or "").lower()
    return any(marker in lowered for marker in _SUCCESS_CLAIM_MARKERS)

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


def _build_nudge(text: str, registry: MCPRegistry, tools_called: set[str] | None = None) -> str | None:
    music = _looks_like_music_request(text)
    browser = _looks_like_browser_request(text)
    from .spotify_client import spotify_mcp
    from .browser_client import browser_mcp
    tools_called = tools_called or set()

    required = _required_spotify_tools(text)
    if required and spotify_mcp.enabled:
        missing = required - tools_called
        if missing:
            track_query = _extract_track_query(text)
            if track_query and "playMusic" not in tools_called:
                return (
                    f"You must search and play '{track_query}' on Spotify: "
                    f"call searchSpotify(query=\"{track_query}\", type=\"track\") "
                    "then playMusic with the track uri. "
                    "Do not claim success without successful tool results."
                )
            tool_name = next(iter(missing))
            return (
                f"You must call Spotify tool `{tool_name}` for this request before answering. "
                "Do not claim success without a successful tool result."
            )

    if music and spotify_mcp.enabled and not browser:
        return (
            "You must use Spotify tools for this request. "
            "Call pausePlayback, resumePlayback, searchSpotify/playMusic, or the right playback tool now. "
            "Do not pretend music changed."
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
        tools_called: set[str] = set()

        track_query = _extract_track_query(text)
        from .spotify_client import spotify_mcp

        if track_query and spotify_mcp.enabled:
            try:
                _auto_play_track(self.registry, messages, tools_called, track_query)
            except Exception as e:
                logger.warning(f"Auto play track failed: {e}")
        else:
            auto_tool = _playback_auto_tool(text)
            if auto_tool and spotify_mcp.enabled:
                tool_name, tool_args = auto_tool
                try:
                    result_text = self.registry.call_tool(tool_name, tool_args)
                    _append_tool_exchange(
                        messages, tools_called, tool_name, tool_args, result_text
                    )
                    logger.info(
                        f"Auto {tool_name} for playback request: "
                        f"{result_text.replace(chr(10), ' ')[:240]}"
                    )
                except Exception as e:
                    logger.warning(f"Auto {tool_name} failed: {e}")

        if _looks_like_browser_request(text):
            from .browser_client import browser_mcp

            if browser_mcp.enabled:
                browser_mcp.mark_tool_activity()
        logger.info(f"MCP tool agent starting with {len(ollama_tools)} tools")

        final_content = ""
        nudged_for_tools = 0
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
                nudge = _build_nudge(text, self.registry, tools_called) if tool_intent else None
                hallucinated = _claims_playback_success_without_tools(
                    final_content, tools_called, text
                )
                if (nudge or hallucinated) and nudged_for_tools < 3:
                    nudged_for_tools += 1
                    logger.warning(
                        "Tool intent detected but model returned no tool_calls; nudging "
                        f"({nudged_for_tools}/3)"
                    )
                    messages.append(msg_dict)
                    messages.append(
                        {
                            "role": "user",
                            "content": nudge
                            or (
                                "You claimed Spotify changed but no playback tool ran. "
                                "Call the correct Spotify tool now, then answer briefly."
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
                name = _PLAYBACK_TOOL_ALIASES.get(name, name)
                arguments = normalize_tool_arguments(name, arguments)
                if not name:
                    result_text = "Error: missing tool name"
                else:
                    logger.info(f"Calling MCP tool: {name}({arguments})")
                    try:
                        result_text = self.registry.call_tool(name, arguments)
                        tools_called.add(name)
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
