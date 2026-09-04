"""Registry for multiple MCP clients (Spotify, Browser, …)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol

from services.lib.LAV_logger import logger
from .browser_client import BROWSER_SYSTEM_HINT, browser_mcp
from .spotify_client import SPOTIFY_SYSTEM_HINT, spotify_mcp


class MCPClientProtocol(Protocol):
    enabled: bool

    def set_enabled(self, enabled: bool) -> None: ...
    def get_tools(self) -> List[Any]: ...
    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> str: ...
    def ping_tools(self) -> Dict[str, Any]: ...
    def status(self) -> Dict[str, Any]: ...


class MCPRegistry:
    """Merge tools from enabled MCP clients and route tool calls."""

    def __init__(self) -> None:
        self._clients: Dict[str, MCPClientProtocol] = {
            "spotify": spotify_mcp,
            "browser": browser_mcp,
        }
        self._tool_owner: Dict[str, str] = {}

    def any_enabled(self) -> bool:
        return any(c.enabled for c in self._clients.values())

    def set_spotify_enabled(self, enabled: bool) -> None:
        spotify_mcp.set_enabled(enabled)

    def set_browser_enabled(self, enabled: bool) -> None:
        browser_mcp.set_enabled(enabled)

    def get_enabled_clients(self) -> List[MCPClientProtocol]:
        return [c for c in self._clients.values() if c.enabled]

    def get_system_hints(self) -> List[str]:
        hints: List[str] = []
        if spotify_mcp.enabled:
            hints.append(SPOTIFY_SYSTEM_HINT)
        if browser_mcp.enabled:
            hints.append(BROWSER_SYSTEM_HINT)
        return hints

    def get_all_tools(self) -> List[Any]:
        self._tool_owner.clear()
        merged: List[Any] = []
        for key, client in self._clients.items():
            if not client.enabled:
                continue
            try:
                tools = client.get_tools()
            except Exception as e:
                logger.warning(f"{key} MCP get_tools failed: {e}")
                continue
            for tool in tools:
                name = getattr(tool, "name", None)
                if not name and isinstance(tool, dict):
                    name = tool.get("name")
                if not name:
                    continue
                if name in self._tool_owner and self._tool_owner[name] != key:
                    logger.warning(
                        f"Tool name collision: {name} ({self._tool_owner[name]} vs {key})"
                    )
                self._tool_owner[name] = key
                merged.append(tool)
        return merged

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        owner = self._tool_owner.get(name)
        if owner is None:
            # Rebuild map if stale (e.g. first call after partial init)
            self.get_all_tools()
            owner = self._tool_owner.get(name)
        if owner is None:
            raise RuntimeError(f"No MCP client owns tool '{name}'")
        return self._clients[owner].call_tool(name, arguments)

    def ping_all(self) -> Dict[str, Any]:
        return {
            key: client.ping_tools() for key, client in self._clients.items()
        }

    def ping_browser(self) -> Dict[str, Any]:
        return browser_mcp.ping_tools()

    def ping_spotify(self) -> Dict[str, Any]:
        return spotify_mcp.ping_tools()


# Process-wide singleton
mcp_registry = MCPRegistry()
