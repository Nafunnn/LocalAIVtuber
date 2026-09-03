import { Panel } from "@/components/panel";
import SettingSwitch from "@/components/setting-switch";
import SettingDropdown from "@/components/setting-dropdown";
import { useSettings } from "@/context/SettingsContext";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface OllamaStatus {
    api_key_set: boolean;
    connected: boolean;
    error: string | null;
}

interface SpotifyMcpStatus {
    enabled: boolean;
    serverBuilt: boolean;
    configExists: boolean;
    authenticated: boolean;
    connected: boolean;
    toolCount: number;
    error: string | null;
}

function SettingsPage() {
    const { loading, settings } = useSettings();
    const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
    const [spotifyStatus, setSpotifyStatus] = useState<SpotifyMcpStatus | null>(null);
    const provider = settings["llm.provider"] ?? "ollama_cloud";
    const isOllamaCloud = provider === "ollama_cloud";
    const spotifyEnabled = Boolean(settings["mcp.spotify.enabled"]);

    const fetchSpotifyStatus = useCallback(async () => {
        try {
            const res = await fetch("/api/mcp/spotify/status");
            if (res.ok) {
                setSpotifyStatus(await res.json());
            }
        } catch (error) {
            console.error("Failed to fetch Spotify MCP status:", error);
        }
    }, []);

    useEffect(() => {
        const fetchOllamaStatus = async () => {
            try {
                const res = await fetch("/api/llm/ollama/status");
                if (res.ok) {
                    setOllamaStatus(await res.json());
                }
            } catch (error) {
                console.error("Failed to fetch Ollama status:", error);
            }
        };
        fetchOllamaStatus();
    }, [provider]);

    useEffect(() => {
        fetchSpotifyStatus();
    }, [fetchSpotifyStatus, spotifyEnabled, provider]);

    if (loading) {
        return <div>Loading settings...</div>;
    }

    const spotifyReady =
        spotifyStatus &&
        spotifyStatus.serverBuilt &&
        spotifyStatus.authenticated &&
        !spotifyStatus.error;
    const spotifyMessage = (() => {
        if (!spotifyStatus) {
            return "Checking Spotify MCP…";
        }
        if (spotifyStatus.error) {
            return spotifyStatus.error;
        }
        if (!spotifyStatus.serverBuilt) {
            return "Spotify MCP server not built. Run scripts/setup-spotify-mcp.ps1";
        }
        if (!spotifyStatus.authenticated) {
            return "Spotify not authenticated. Configure spotify-config.json and run npm run auth (see docs/SPOTIFY_MCP.md)";
        }
        if (spotifyEnabled && spotifyStatus.connected) {
            return `Spotify MCP ready (${spotifyStatus.toolCount} tools)`;
        }
        if (spotifyEnabled) {
            return "Spotify MCP enabled — will connect on first music request";
        }
        return "Spotify MCP configured. Enable the switch to let the AI control Spotify.";
    })();

    return (
        <div className="h-full overflow-y-auto p-5">
            <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">Settings</h3>
            <Panel className="max-w-4xl mx-auto flex flex-col gap-4">
                <SettingDropdown
                    id="llm.provider"
                    defaultValue="ollama_cloud"
                    label="LLM Provider"
                    description="Choose between local GGUF models or Ollama Cloud."
                    options={{
                        gguf: "Local GGUF",
                        ollama_cloud: "Ollama Cloud",
                    }}
                    onValueChange={() => {}}
                />

                {isOllamaCloud && ollamaStatus && (
                    <div className={`flex items-center gap-2 text-sm p-3 rounded-md ${
                        ollamaStatus.connected
                            ? "bg-green-500/10 text-green-600 dark:text-green-400"
                            : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                    }`}>
                        {ollamaStatus.connected ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                        ) : (
                            <AlertCircle className="h-4 w-4 shrink-0" />
                        )}
                        <span>
                            {ollamaStatus.connected
                                ? "OLLAMA_API_KEY detected and connected to Ollama Cloud"
                                : ollamaStatus.error ?? "OLLAMA_API_KEY not configured"}
                        </span>
                    </div>
                )}

                {!isOllamaCloud && (
                    <SettingSwitch
                        id="load-llm-cpu"
                        label="Load LLM on CPU"
                        description="For reducing load on lower-end graphics cards, latency will be increased."
                    />
                )}
                <SettingSwitch
                    id="disable-pipeline"
                    label="Disable Pipeline"
                    description="For testing individual pipeline stages without triggering the entire pipeline."
                />
                {!isOllamaCloud && (
                    <SettingSwitch
                        id="llm.keep_model_loaded"
                        label="Keep LLM loaded"
                        description="For unloading LLM when inference finishes."
                    />
                )}

                <SettingSwitch
                    id="mcp.spotify.enabled"
                    label="Spotify MCP"
                    description="Let the AI search, play, and manage Spotify (Ollama Cloud + Premium required). See docs/SPOTIFY_MCP.md."
                    onClick={() => {
                        // Refresh after settings persist
                        setTimeout(fetchSpotifyStatus, 400);
                    }}
                />
                {spotifyStatus && (
                    <div
                        className={`flex items-center gap-2 text-sm p-3 rounded-md ${
                            spotifyReady && spotifyEnabled
                                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                        }`}
                    >
                        {spotifyReady && spotifyEnabled ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                        ) : (
                            <AlertCircle className="h-4 w-4 shrink-0" />
                        )}
                        <span>{spotifyMessage}</span>
                    </div>
                )}
                {!isOllamaCloud && spotifyEnabled && (
                    <p className="text-sm text-muted-foreground">
                        Spotify tools only run with the Ollama Cloud provider. Switch provider above to use them.
                    </p>
                )}
            </Panel>
        </div>
    );
}

export default SettingsPage;
