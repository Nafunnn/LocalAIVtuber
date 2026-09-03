"""Convert MCP tool definitions to Ollama tool schemas."""

from __future__ import annotations

from typing import Any, Dict, List


def mcp_tools_to_ollama(tools: List[Any]) -> List[Dict[str, Any]]:
    """Map MCP list_tools() entries to Ollama chat `tools` JSON schemas."""
    ollama_tools: List[Dict[str, Any]] = []
    for tool in tools:
        name = getattr(tool, "name", None) or tool.get("name")
        description = getattr(tool, "description", None)
        if description is None and isinstance(tool, dict):
            description = tool.get("description")
        input_schema = getattr(tool, "inputSchema", None)
        if input_schema is None and isinstance(tool, dict):
            input_schema = tool.get("inputSchema") or tool.get("input_schema")
        if not name:
            continue
        parameters: Dict[str, Any]
        if isinstance(input_schema, dict):
            parameters = dict(input_schema)
        else:
            parameters = {"type": "object", "properties": {}}
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


def tool_result_to_text(result: Any) -> str:
    """Flatten an MCP CallToolResult into a string for the LLM."""
    if result is None:
        return ""
    if getattr(result, "isError", False):
        prefix = "Error: "
    else:
        prefix = ""
    content = getattr(result, "content", None)
    if content is None:
        return prefix + str(result)
    parts: List[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text:
            parts.append(text)
        else:
            parts.append(str(block))
    return prefix + ("\n".join(parts) if parts else str(result))
