# Browser MCP setup (LocalAIVtuber)



LocalAIVtuber uses [Better Browser MCP](https://github.com/nbiish/betterbrowsermcp) on **port 9010** so it can run alongside Cursor's official Browser MCP (port 9009) without conflict.



## Prerequisites



- **Node.js 16+**, **git**, **npm**

- **Google Chrome** with the **Better Browser MCP extension** (vendored in this repo)

- LocalAIVtuber using **Ollama Cloud** with a tool-capable model (e.g. `gemma4:31b`, `qwen3.5`)

- Python package `mcp` in `backend/venv`



```powershell

cd backend

.\venv\Scripts\pip.exe install -r requirements.txt

```



## 1. Install server + extension



From the repo root:



```powershell

powershell -ExecutionPolicy Bypass -File .\scripts\setup-browser-mcp.ps1

```



This clones and builds:



- `third_party/betterbrowsermcp` — MCP server (stdio + WebSocket)

- `third_party/betterbrowsermcp-extension` — Chrome extension (load unpacked)



Default LocalAIVtuber endpoint:



```

ws://127.0.0.1:9010/ws/localaivtuber

```



## 2. Load the Chrome extension



1. Open `chrome://extensions`

2. Enable **Developer mode**

3. **Load unpacked** → select `third_party/betterbrowsermcp-extension`

4. Pin the extension in the toolbar



## 3. Configure the extension



Click the extension icon → **Add an agent**:



| Field | Value |

|-------|-------|

| Agent ID | `localaivtuber` |

| Port | `9010` |



Then open the tab you want the AI to control and **bind that tab** to agent `localaivtuber`.



## 4. Enable in LocalAIVtuber



1. Start backend + frontend

2. Settings → **Ollama Cloud**

3. Enable **Browser MCP**

4. Status should show ready when the tab is bound



Spotify MCP can stay enabled at the same time.



## 5. Try it in chat



- "Go to google.com and search for VTuber"

- "Open Wikipedia and summarize the VTuber article"

- "Search lo-fi on Spotify and play one" (with Spotify MCP enabled)



## Running alongside Cursor



| App | Package | Port | Agent ID |

|-----|---------|------|----------|

| Cursor | `@browsermcp/mcp` | 9009 | (default) |

| LocalAIVtuber | `betterbrowsermcp` | **9010** | `localaivtuber` |



No need to disable Cursor's Browser MCP. Add both endpoints in the Better Browser MCP extension if you use both.



## Settings (optional)



In `backend/settings.json`:



```json

{

  "mcp.browser.enabled": true,

  "mcp.browser.port": 9010,

  "mcp.browser.agentId": "localaivtuber"

}

```



Change port/agent only if 9010 is already taken. Update the extension endpoint to match.



## Troubleshooting



| Symptom | Fix |

|--------|-----|

| Server not built | Re-run `scripts/setup-browser-mcp.ps1` |

| Port already in use | Change `mcp.browser.port` (e.g. 9011) and update extension |

| Extension shows `Connection closed (1006)` | Enable **Browser MCP** in LocalAIVtuber Settings first — the WebSocket server only runs when enabled |
| Extension disconnected | Bind tab to agent `localaivtuber` in the extension popup |

| Wrong extension | Use `betterbrowsermcp-extension`, not the stock Browser MCP extension alone |

| Tools ignored on GGUF | Switch to Ollama Cloud |

| Model never calls tools | Use a tool-capable cloud model |
| `npm run build` fails (path has `&`) | Setup script uses `node node_modules/tsup/...` directly — re-run `setup-browser-mcp.ps1` |



## Security



- Server binds to **127.0.0.1** only (localhost)

- Better Browser MCP does **not** kill other processes on port 9009

- The AI can still control any bound tab including logged-in sites — enable only when you trust the model



## Architecture



1. Backend spawns `node third_party/betterbrowsermcp/dist/index.js` with `BROWSER_MCP_PORT=9010`

2. Server listens on `ws://127.0.0.1:9010/ws/localaivtuber`

3. Extension multiplexes multiple agents/tabs

4. `/api/completion` runs the unified MCP tool agent when browser (and/or Spotify) MCP is enabled

