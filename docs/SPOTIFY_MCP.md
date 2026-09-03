# Spotify MCP setup (LocalAIVtuber)

This project integrates [marcelmarais/spotify-mcp-server](https://github.com/marcelmarais/spotify-mcp-server) so the VTuber AI (Ollama Cloud) can search music, control playback, and manage playlists through chat.

## Prerequisites

- **Node.js 16+** and npm
- **Spotify Premium** (required by Spotify’s playback Web API)
- A **Spotify Developer** application
- LocalAIVtuber using **Ollama Cloud** with a tool-capable model (e.g. `gemma4:31b`, `qwen3.5`)
- Python package `mcp` installed in `backend/venv`

```powershell
cd backend
.\venv\Scripts\pip.exe install -r requirements.txt
```

## 1. Install / build the MCP server

From the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-spotify-mcp.ps1
```

This clones into `third_party/spotify-mcp-server`, runs `npm install`, builds TypeScript, and creates `spotify-config.json` from the example if missing.

## 2. Create a Spotify Developer app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Log in and create an app
3. Copy **Client ID** and **Client Secret**
4. Edit Settings → add Redirect URI: `http://127.0.0.1:8888/callback`
5. Save

## 3. Configure credentials

Edit `third_party/spotify-mcp-server/spotify-config.json`:

```json
{
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "redirectUri": "http://127.0.0.1:8888/callback"
}
```

Do **not** commit this file (it is gitignored). Tokens are written here after auth.

## 4. Authenticate (OAuth)

```powershell
cd third_party\spotify-mcp-server
npm run auth
```

If `npm run auth` fails because the repo path contains `&`, run:

```powershell
node .\node_modules\typescript\bin\tsc
node .\build\auth.js
```

1. Open the printed authorization URL in a browser
2. Approve the app
3. Tokens (`accessToken`, `refreshToken`, `expiresAt`) are saved into `spotify-config.json`
4. The MCP server refreshes tokens automatically; re-run auth only if refresh fails

## 5. Enable in LocalAIVtuber

1. Start Spotify desktop or web (an **active device** is required for play/pause/volume)
2. Start the LocalAIVtuber backend and frontend
3. Settings → set **LLM Provider** to **Ollama Cloud**
4. Enable **Spotify MCP**
5. Status should show ready / authenticated (or will connect on first music request)

## 6. Try it in chat

Examples:

- “Search for lo-fi beats and play one”
- “What’s playing right now?”
- “Create a chill playlist called Study Mix”
- “Turn the volume down a bit”
- “Skip to the next song”

The model runs Spotify tools silently, then speaks a short in-character reply (TTS-friendly).

## Optional: use the same server in Cursor

In Cursor MCP settings:

```json
{
  "mcpServers": {
    "spotify": {
      "command": "node",
      "args": ["C:/absolute/path/to/LocalAIVtuber/third_party/spotify-mcp-server/build/index.js"]
    }
  }
}
```

Use your real absolute path. Auth still uses the same `spotify-config.json`.

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| Server not built | Re-run `scripts/setup-spotify-mcp.ps1` |
| Not authenticated | Fill client id/secret, then `npm run auth` |
| No active device | Open Spotify on PC/phone and start playing once |
| Tools ignored on GGUF | Switch provider to Ollama Cloud |
| Model never calls tools | Use a tool-capable cloud model (`gemma4`, `qwen3`, etc.) |
| Path/`tsc` errors with `&` in folder name | Call `node .\node_modules\typescript\bin\tsc` directly (setup script already does this) |

## Architecture (short)

1. Backend spawns `node …/build/index.js` over MCP stdio
2. When `mcp.spotify.enabled` is on and provider is Ollama Cloud, `/api/completion` runs a tool agent loop
3. Intermediate tool calls are not streamed to TTS; only the final reply is
