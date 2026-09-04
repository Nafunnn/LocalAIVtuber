"""Stdio MCP client for the vendored Spotify MCP server."""

from __future__ import annotations

import asyncio
import json
import os
import threading
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from services.lib.LAV_logger import logger
from .schemas import tool_result_to_text

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DEFAULT_SERVER_DIR = os.path.join(REPO_ROOT, "third_party", "spotify-mcp-server")
DEFAULT_INDEX_JS = os.path.join(DEFAULT_SERVER_DIR, "build", "index.js")
DEFAULT_CONFIG_PATH = os.path.join(DEFAULT_SERVER_DIR, "spotify-config.json")

SPOTIFY_SYSTEM_HINT = (
    "Spotify tools are available and MUST be used for any music request "
    "(play, pause, skip, search, playlist, volume, queue, what's playing). "
    "Never claim you played or changed music unless a tool succeeded. "
    "Typical play flow: searchSpotify(query, type=\"track\") then playMusic with the track uri/id. "
    "For searchSpotify the parameter is named query (not q). "
    "After tools finish, reply briefly and naturally in character—do not narrate JSON or tool names. "
    "If a tool errors (no device, auth, etc.), say that honestly in character."
)


class SpotifyMCPClient:
    """Persistent stdio MCP session to spotify-mcp-server, driven from a private event loop."""

    def __init__(
        self,
        server_dir: str = DEFAULT_SERVER_DIR,
        index_js: str = DEFAULT_INDEX_JS,
        config_path: str = DEFAULT_CONFIG_PATH,
    ):
        self.server_dir = server_dir
        self.index_js = index_js
        self.config_path = config_path
        self._enabled = False
        self._lock = threading.RLock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._stack: Optional[AsyncExitStack] = None
        self._session: Optional[ClientSession] = None
        self._tools_cache: Optional[List[Any]] = None
        self._last_error: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            was = self._enabled
            self._enabled = bool(enabled)
            if was and not self._enabled:
                self._stop_sync()
            logger.info(f"Spotify MCP enabled={self._enabled}")

    def server_built(self) -> bool:
        return os.path.isfile(self.index_js)

    def config_exists(self) -> bool:
        return os.path.isfile(self.config_path)

    def config_has_tokens(self) -> bool:
        if not self.config_exists():
            return False
        try:
            with open(self.config_path, encoding="utf-8") as f:
                cfg = json.load(f)
            access = str(cfg.get("accessToken") or "")
            refresh = str(cfg.get("refreshToken") or "")
            placeholder = "run-npm auth"
            return bool(
                access
                and refresh
                and placeholder not in access
                and placeholder not in refresh
                and cfg.get("clientId")
                and cfg.get("clientSecret")
            )
        except (OSError, json.JSONDecodeError):
            return False

    def status(self) -> Dict[str, Any]:
        with self._lock:
            connected = self._session is not None
            return {
                "enabled": self._enabled,
                "serverPath": self.index_js,
                "serverBuilt": self.server_built(),
                "configPath": self.config_path,
                "configExists": self.config_exists(),
                "authenticated": self.config_has_tokens(),
                "connected": connected,
                "toolCount": len(self._tools_cache) if self._tools_cache else 0,
                "error": self._last_error,
            }

    def ensure_ready(self) -> None:
        """Connect and cache tools if enabled. Raises on failure."""
        with self._lock:
            if not self._enabled:
                raise RuntimeError("Spotify MCP is disabled")
            if not self.server_built():
                raise RuntimeError(
                    f"Spotify MCP server not built. Run scripts/setup-spotify-mcp.ps1 "
                    f"(expected {self.index_js})"
                )
            if not self.config_has_tokens():
                raise RuntimeError(
                    "Spotify is not authenticated. Edit spotify-config.json and run "
                    "`npm run auth` in third_party/spotify-mcp-server (see docs/SPOTIFY_MCP.md)."
                )
            self._ensure_loop()
            if self._session is None:
                self._run(self._connect())
            if self._tools_cache is None:
                self._tools_cache = self._run(self._list_tools())

    def get_tools(self) -> List[Any]:
        self.ensure_ready()
        assert self._tools_cache is not None
        return self._tools_cache

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        self.ensure_ready()

        async def _call():
            assert self._session is not None
            try:
                result = await self._session.call_tool(name, arguments or {})
                return tool_result_to_text(result)
            except Exception as e:
                self._last_error = str(e)
                logger.error(f"Spotify MCP tool '{name}' failed: {e}")
                # Attempt one reconnect then retry once
                await self._reconnect()
                result = await self._session.call_tool(name, arguments or {})
                return tool_result_to_text(result)

        return self._run(_call(), timeout=90)

    def ping_tools(self) -> Dict[str, Any]:
        """Connect (if enabled) and return status after listing tools."""
        try:
            if not self._enabled:
                st = self.status()
                st["error"] = None
                return st
            self.ensure_ready()
            self._last_error = None
            return self.status()
        except Exception as e:
            self._last_error = str(e)
            logger.warning(f"Spotify MCP status check failed: {e}")
            st = self.status()
            st["error"] = str(e)
            return st

    def shutdown(self) -> None:
        with self._lock:
            self._enabled = False
            self._stop_sync()
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._loop.stop)
            if self._thread and self._thread.is_alive():
                self._thread.join(timeout=5)
            self._loop = None
            self._thread = None

    # --- internals ---

    def _ensure_loop(self) -> None:
        if self._loop and self._loop.is_running():
            return

        ready = threading.Event()

        def _runner():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            ready.set()
            loop.run_forever()

        self._thread = threading.Thread(
            target=_runner, name="spotify-mcp-loop", daemon=True
        )
        self._thread.start()
        if not ready.wait(timeout=5):
            raise RuntimeError("Failed to start Spotify MCP event loop")

    def _run(self, coro, timeout: float = 60):
        assert self._loop is not None
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout=timeout)
        except Exception:
            self._last_error = "MCP call failed"
            raise

    async def _connect(self) -> None:
        await self._disconnect()
        params = StdioServerParameters(
            command="node",
            args=[self.index_js],
            cwd=self.server_dir,
        )
        stack = AsyncExitStack()
        read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        self._stack = stack
        self._session = session
        self._tools_cache = None
        self._last_error = None
        logger.info("Spotify MCP session connected")

    async def _disconnect(self) -> None:
        self._session = None
        self._tools_cache = None
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception as e:
                logger.debug(f"Spotify MCP disconnect: {e}")
            self._stack = None

    async def _reconnect(self) -> None:
        logger.warning("Reconnecting Spotify MCP session")
        await self._connect()
        self._tools_cache = await self._list_tools()

    async def _list_tools(self) -> List[Any]:
        assert self._session is not None
        result = await self._session.list_tools()
        tools = list(result.tools)
        logger.info(f"Spotify MCP tools available: {len(tools)}")
        return tools

    def _stop_sync(self) -> None:
        if self._loop and self._loop.is_running() and self._session is not None:
            try:
                self._run(self._disconnect(), timeout=15)
            except Exception as e:
                logger.debug(f"Spotify MCP stop: {e}")
        self._session = None
        self._stack = None
        self._tools_cache = None


# Process-wide singleton
spotify_mcp = SpotifyMCPClient()
