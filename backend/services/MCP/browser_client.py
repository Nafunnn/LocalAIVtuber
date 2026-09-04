"""Stdio MCP client for Better Browser MCP (nbiish/betterbrowsermcp)."""

from __future__ import annotations

import os
import shutil
from typing import Any, Dict

from services.lib.LAV_logger import logger
from .stdio_client import StdioMCPClient

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DEFAULT_SERVER_DIR = os.path.join(REPO_ROOT, "third_party", "betterbrowsermcp")
DEFAULT_INDEX_JS = os.path.join(DEFAULT_SERVER_DIR, "dist", "index.js")
GITHUB_NPX_PACKAGE = "github:nbiish/betterbrowsermcp"

DEFAULT_BROWSER_PORT = 9010
DEFAULT_AGENT_ID = "localaivtuber"
DEFAULT_BIND = "127.0.0.1"

BROWSER_SYSTEM_HINT = (
    "Browser tools are available and MUST be used for any web request "
    "(search, navigate, open a site, read a page, click, fill forms, screenshots). "
    "Never claim you visited a page or found information unless a browser tool succeeded. "
    "Typical search flow: browser_navigate(url) then browser_snapshot to read the page, "
    "then browser_type / browser_click as needed; snapshot again after navigation or clicks. "
    "If the browser extension is not connected, tell the user to open Chrome, add the "
    "LocalAIVtuber WebSocket endpoint in the Better Browser MCP extension popup, and bind "
    "the target tab to agent 'localaivtuber'. "
    "After tools finish, reply briefly and naturally in character—do not narrate JSON or tool names."
)


def _build_ws_url(port: int, agent_id: str) -> str:
    return f"ws://{DEFAULT_BIND}:{port}/ws/{agent_id}"


class BrowserMCPClient(StdioMCPClient):
    """Persistent stdio MCP session to Better Browser MCP on a dedicated port."""

    def __init__(
        self,
        port: int = DEFAULT_BROWSER_PORT,
        agent_id: str = DEFAULT_AGENT_ID,
        cwd: str = REPO_ROOT,
    ):
        self._port = int(port)
        self._agent_id = str(agent_id).strip() or DEFAULT_AGENT_ID
        self._extension_connected: bool | None = None
        command, args, server_cwd = self._resolve_spawn()
        super().__init__(
            name="Browser",
            command=command,
            args=args,
            cwd=server_cwd,
            env=self._build_env(),
            ready_checks=[self._check_runtime_available, self._check_server_available],
            call_timeout=120,
        )

    @staticmethod
    def runtime_available() -> bool:
        return bool(shutil.which("node") and shutil.which("npx"))

    def server_built(self) -> bool:
        return os.path.isfile(DEFAULT_INDEX_JS)

    def ws_url(self) -> str:
        return _build_ws_url(self._port, self._agent_id)

    def configure(self, port: int | None = None, agent_id: str | None = None) -> None:
        new_port = int(port) if port is not None else self._port
        new_agent = (str(agent_id).strip() if agent_id is not None else self._agent_id) or DEFAULT_AGENT_ID
        if new_port == self._port and new_agent == self._agent_id:
            return
        self._port = new_port
        self._agent_id = new_agent
        self.env = self._build_env()
        command, args, server_cwd = self._resolve_spawn()
        self.command = command
        self.args = args
        self.cwd = server_cwd
        if self._enabled:
            with self._lock:
                self._stop_sync()

    def status(self) -> Dict[str, Any]:
        st = super().status()
        st.update(
            {
                "runtimeAvailable": self.runtime_available(),
                "serverBuilt": self.server_built(),
                "serverPath": DEFAULT_INDEX_JS,
                "port": self._port,
                "agentId": self._agent_id,
                "wsUrl": self.ws_url(),
                "extensionConnected": self._extension_connected,
                "package": "betterbrowsermcp",
            }
        )
        return st

    def check_extension_connected(self) -> bool:
        """Probe whether the Chrome extension is connected via a lightweight tool call."""
        if not self._enabled:
            self._extension_connected = None
            return False
        try:
            self.ensure_ready()
            result = self.call_tool("browser_snapshot", {})
            lowered = (result or "").lower()
            disconnected_markers = (
                "not connected",
                "no connection to browser extension",
                "no websocket",
                "extension",
                "client closed",
                "connect a tab",
            )
            if any(m in lowered for m in disconnected_markers):
                self._extension_connected = False
                return False
            self._extension_connected = True
            return True
        except Exception as e:
            msg = str(e).lower()
            if any(
                m in msg
                for m in (
                    "not connected",
                    "no connection",
                    "websocket",
                    "extension",
                    "econnrefused",
                    "eaddrinuse",
                )
            ):
                self._extension_connected = False
                return False
            if "port" in msg and "in use" in msg:
                self._extension_connected = False
                return False
            self._extension_connected = True
            return True

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            was = self._enabled
            self._enabled = bool(enabled)
            if was and not self._enabled:
                self._stop_sync()
                self._extension_connected = None
                logger.info(f"{self.name} MCP enabled={self._enabled}")
                return
            logger.info(f"{self.name} MCP enabled={self._enabled}")
        if self._enabled:
            self.start_daemon()

    def start_daemon(self) -> None:
        """Start the MCP process so the WebSocket server stays up for the extension."""
        try:
            self.ensure_ready()
            self._last_error = None
            logger.info(f"Browser MCP WebSocket listening at {self.ws_url()}")
        except Exception as e:
            self._last_error = str(e)
            logger.error(f"Failed to start Browser MCP daemon: {e}")
            raise

    def ping_tools(self) -> Dict[str, Any]:
        st = super().ping_tools()
        if not self._enabled:
            return st
        if st.get("error") and "disabled" in str(st.get("error", "")).lower():
            return st
        # Server up — check extension separately (don't fail status if tab unbound yet)
        if not st.get("error"):
            connected = self.check_extension_connected()
            st["extensionConnected"] = connected
            st["wsListening"] = True
            if not connected:
                st["error"] = (
                    f"WebSocket server is running at {self.ws_url()}, but no tab is bound yet. "
                    f"In the Better Browser MCP extension, bind a tab to agent '{self._agent_id}'."
                )
        return st

    def _build_env(self) -> Dict[str, str]:
        return {
            "BROWSER_MCP_PORT": str(self._port),
            "BROWSER_MCP_AGENT_ID": self._agent_id,
            "BROWSER_MCP_BIND": DEFAULT_BIND,
        }

    def _resolve_spawn(self) -> tuple[str, list[str], str]:
        if self.server_built():
            return "node", [DEFAULT_INDEX_JS], DEFAULT_SERVER_DIR
        return "npx", ["-y", GITHUB_NPX_PACKAGE], REPO_ROOT

    def _check_runtime_available(self) -> None:
        if not self.runtime_available():
            raise RuntimeError(
                "Node.js and npx are required for Browser MCP. Install from https://nodejs.org/"
            )

    def _check_server_available(self) -> None:
        if not self.server_built():
            raise RuntimeError(
                "Better Browser MCP server not built. Run scripts/setup-browser-mcp.ps1 "
                f"(expected {DEFAULT_INDEX_JS})"
            )


# Process-wide singleton
browser_mcp = BrowserMCPClient()
