"""Convert MCP tool definitions to Ollama tool schemas."""

from __future__ import annotations

from typing import Any, Dict, List

_MAX_SNAPSHOT_CHARS = 12000


def _get_input_schema(tool: Any) -> Dict[str, Any] | None:
    """Read JSON schema from MCP Tool (SDK v1 camelCase or v2 snake_case)."""
    for attr in ("input_schema", "inputSchema"):
        value = getattr(tool, attr, None)
        if isinstance(value, dict):
            return value
    if isinstance(tool, dict):
        for key in ("input_schema", "inputSchema"):
            value = tool.get(key)
            if isinstance(value, dict):
                return value
    if hasattr(tool, "model_dump"):
        dumped = tool.model_dump()
        for key in ("input_schema", "inputSchema"):
            value = dumped.get(key)
            if isinstance(value, dict):
                return value
    return None


def mcp_tools_to_ollama(tools: List[Any]) -> List[Dict[str, Any]]:
    """Map MCP list_tools() entries to Ollama chat `tools` JSON schemas."""
    ollama_tools: List[Dict[str, Any]] = []
    for tool in tools:
        name = getattr(tool, "name", None)
        if not name and isinstance(tool, dict):
            name = tool.get("name")
        description = getattr(tool, "description", None)
        if description is None and isinstance(tool, dict):
            description = tool.get("description")
        input_schema = _get_input_schema(tool)
        if not name:
            continue
        if isinstance(input_schema, dict):
            parameters = dict(input_schema)
        else:
            parameters = {"type": "object", "properties": {}}
        parameters.pop("$schema", None)
        if "type" not in parameters:
            parameters["type"] = "object"
        if "properties" not in parameters:
            parameters["properties"] = {}
        ollama_tools.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description or name,
                    "parameters": parameters,
                },
            }
        )
    return ollama_tools


def normalize_tool_arguments(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Fix common model mistakes in MCP tool args."""
    args = dict(arguments or {})
    if name == "searchSpotify":
        if "query" not in args and "q" in args:
            args["query"] = args.pop("q")
        if "type" not in args:
            args["type"] = "track"
    if name == "playMusic":
        if "uri" not in args and "trackUri" in args:
            args["uri"] = args.pop("trackUri")
        if "uri" not in args and "spotify_uri" in args:
            args["uri"] = args.pop("spotify_uri")
    if name == "browser_navigate":
        if "url" not in args and "link" in args:
            args["url"] = args.pop("link")
        if "url" not in args and "href" in args:
            args["url"] = args.pop("href")
    if name == "browser_type":
        if "text" not in args and "value" in args:
            args["text"] = args.pop("value")
    return args


def _truncate_snapshot_text(text: str) -> str:
    if len(text) <= _MAX_SNAPSHOT_CHARS:
        return text
    return text[:_MAX_SNAPSHOT_CHARS] + "\n… [truncated for context length]"


def tool_result_to_text(result: Any) -> str:
    """Flatten an MCP CallToolResult into a string for the LLM."""
    if result is None:
        return ""
    is_error = bool(
        getattr(result, "isError", None)
        if getattr(result, "isError", None) is not None
        else getattr(result, "is_error", False)
    )
    prefix = "Error: " if is_error else ""
    content = getattr(result, "content", None)
    if content is None:
        return prefix + str(result)
    parts: List[str] = []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type is None and isinstance(block, dict):
            block_type = block.get("type")
        if block_type == "image":
            parts.append("[Screenshot captured]")
            continue
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text:
            parts.append(_truncate_snapshot_text(text))
        else:
            parts.append(str(block))
    return prefix + ("\n".join(parts) if parts else str(result))
