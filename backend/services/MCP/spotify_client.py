"""Stdio MCP client for the vendored Spotify MCP server."""

from __future__ import annotations

import json
import os
from typing import Any, Dict

from .stdio_client import StdioMCPClient

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


class SpotifyMCPClient(StdioMCPClient):
    """Persistent stdio MCP session to spotify-mcp-server."""

    def __init__(
        self,
        server_dir: str = DEFAULT_SERVER_DIR,
        index_js: str = DEFAULT_INDEX_JS,
        config_path: str = DEFAULT_CONFIG_PATH,
    ):
        self.server_dir = server_dir
        self.index_js = index_js
        self.config_path = config_path
        super().__init__(
            name="Spotify",
            command="node",
            args=[self.index_js],
            cwd=self.server_dir,
            ready_checks=[self._check_server_built, self._check_authenticated],
        )

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
        st = super().status()
        st.update(
            {
                "serverPath": self.index_js,
                "serverBuilt": self.server_built(),
                "configPath": self.config_path,
                "configExists": self.config_exists(),
                "authenticated": self.config_has_tokens(),
            }
        )
        return st

    def _check_server_built(self) -> None:
        if not self.server_built():
            raise RuntimeError(
                f"Spotify MCP server not built. Run scripts/setup-spotify-mcp.ps1 "
                f"(expected {self.index_js})"
            )

    def _check_authenticated(self) -> None:
        if not self.config_has_tokens():
            raise RuntimeError(
                "Spotify is not authenticated. Edit spotify-config.json and run "
                "`npm run auth` in third_party/spotify-mcp-server (see docs/SPOTIFY_MCP.md)."
            )


# Process-wide singleton
spotify_mcp = SpotifyMCPClient()
