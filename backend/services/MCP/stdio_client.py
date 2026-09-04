"""Shared stdio MCP client lifecycle (private asyncio loop + session)."""

from __future__ import annotations

import asyncio
import os
import threading
from contextlib import AsyncExitStack
from typing import Any, Callable, Dict, List, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from services.lib.LAV_logger import logger
from .schemas import tool_result_to_text

ReadyCheck = Callable[[], None]


class StdioMCPClient:
    """Persistent stdio MCP session driven from a private event loop."""

    def __init__(
        self,
        *,
        name: str,
        command: str,
        args: List[str],
        cwd: str,
        env: Optional[Dict[str, str]] = None,
        ready_checks: Optional[List[ReadyCheck]] = None,
        call_timeout: float = 90,
    ):
        self.name = name
        self.command = command
        self.args = list(args)
        self.cwd = cwd
        self.env = dict(env or {})
        self.ready_checks = ready_checks or []
        self.call_timeout = call_timeout
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
            logger.info(f"{self.name} MCP enabled={self._enabled}")

    def base_status(self) -> Dict[str, Any]:
        with self._lock:
            connected = self._session is not None
            return {
                "enabled": self._enabled,
                "command": self.command,
                "args": self.args,
                "cwd": self.cwd,
                "env": {k: v for k, v in self.env.items() if "TOKEN" not in k.upper()},
                "connected": connected,
                "toolCount": len(self._tools_cache) if self._tools_cache else 0,
                "error": self._last_error,
            }

    def ensure_ready(self) -> None:
        """Connect and cache tools if enabled. Raises on failure."""
        with self._lock:
            if not self._enabled:
                raise RuntimeError(f"{self.name} MCP is disabled")
            for check in self.ready_checks:
                check()
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
                logger.error(f"{self.name} MCP tool '{name}' failed: {e}")
                await self._reconnect()
                result = await self._session.call_tool(name, arguments or {})
                return tool_result_to_text(result)

        return self._run(_call(), timeout=self.call_timeout)

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
            logger.warning(f"{self.name} MCP status check failed: {e}")
            st = self.status()
            st["error"] = str(e)
            return st

    def status(self) -> Dict[str, Any]:
        return self.base_status()

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
            target=_runner, name=f"{self.name.lower()}-mcp-loop", daemon=True
        )
        self._thread.start()
        if not ready.wait(timeout=5):
            raise RuntimeError(f"Failed to start {self.name} MCP event loop")

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
        merged_env = os.environ.copy()
        merged_env.update(self.env)
        params = StdioServerParameters(
            command=self.command,
            args=self.args,
            cwd=self.cwd,
            env=merged_env,
        )
        stack = AsyncExitStack()
        read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        self._stack = stack
        self._session = session
        self._tools_cache = None
        self._last_error = None
        logger.info(f"{self.name} MCP session connected")

    async def _disconnect(self) -> None:
        self._session = None
        self._tools_cache = None
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception as e:
                logger.debug(f"{self.name} MCP disconnect: {e}")
            self._stack = None

    async def _reconnect(self) -> None:
        logger.warning(f"Reconnecting {self.name} MCP session")
        await self._connect()
        self._tools_cache = await self._list_tools()

    async def _list_tools(self) -> List[Any]:
        assert self._session is not None
        result = await self._session.list_tools()
        tools = list(result.tools)
        logger.info(f"{self.name} MCP tools available: {len(tools)}")
        return tools

    def _stop_sync(self) -> None:
        if self._loop and self._loop.is_running() and self._session is not None:
            try:
                self._run(self._disconnect(), timeout=15)
            except Exception as e:
                logger.debug(f"{self.name} MCP stop: {e}")
        self._session = None
        self._stack = None
        self._tools_cache = None
