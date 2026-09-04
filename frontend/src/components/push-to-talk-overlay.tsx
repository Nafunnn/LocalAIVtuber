import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { voiceInputManager, type VoiceInputState } from "@/lib/voiceInputManager";
import { pushToTalkController } from "@/lib/pushToTalk";
import { useSettings } from "@/context/SettingsContext";
import { chatManager, ChatManager } from "@/lib/chatManager";
import { ttsManager } from "@/lib/ttsManager";
import { idleAmbientSpeech } from "@/lib/idleAmbientSpeech";

export function PushToTalkOverlay() {
  const { settings } = useSettings();
  const [state, setState] = useState<VoiceInputState>(voiceInputManager.getState());

  // Keep chat/TTS singletons warm and sync system prompt for voice → AI path.
  useEffect(() => {
    void ttsManager;
    idleAmbientSpeech.start({
      enabled: settings["frontend.idleSpeech.enabled"] !== false,
    });
    pushToTalkController.bind();
    return () => {
      pushToTalkController.unbind();
    };
  }, []);

  useEffect(() => {
    idleAmbientSpeech.setEnabled(settings["frontend.idleSpeech.enabled"] !== false);
  }, [settings]);

  useEffect(() => {
    const prompt = settings["llm.system_prompt"];
    if (typeof prompt === "string") {
      chatManager.setSystemPrompt(prompt);
    }
    if (typeof settings["llm.enableMemoryRetrieval"] === "boolean") {
      chatManager.setEnableMemoryRetrieval(settings["llm.enableMemoryRetrieval"]);
    }
    const modelId = typeof settings["llm.ollama.model"] === "string"
      ? settings["llm.ollama.model"]
      : "";
    chatManager.setVisionModelHint(
      settings["llm.provider"] === "ollama_cloud" &&
        ChatManager.modelLooksMultimodal(modelId)
    );
  }, [settings]);

  useEffect(() => {
    return voiceInputManager.subscribe(setState);
  }, []);

  const showOverlay = state.recording || Boolean(state.lastTranscription && state.recording);

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] -translate-x-1/2">
      {state.recording ? (
        <div className="flex min-w-[280px] flex-col gap-2 rounded-xl border border-red-500/40 bg-background/90 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <Mic className="h-4 w-4 text-red-400" />
            Push to talk — release Ctrl+Space to send your full message
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-red-400 transition-all duration-75"
              style={{ width: `${Math.min(100, Math.max(4, state.probability * 100))}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Speech: {`${(state.probability * 100).toFixed(0)}%`} · AI + 3D character will respond
          </p>
        </div>
      ) : (
        <div
          className={`rounded-full border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur transition-opacity ${
            showOverlay ? "opacity-100" : "opacity-70"
          }`}
        >
          Hold <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">Ctrl</kbd>
          {" + "}
          <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">Space</kbd>
          {" — your full message is sent when you release"}
        </div>
      )}
    </div>
  );
}
