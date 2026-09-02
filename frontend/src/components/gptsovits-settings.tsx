import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useEffect, useState } from "react";
import { ttsManager } from "@/lib/ttsManager";
import { GPTSoVITSProvider, TTSVoice } from "@/lib/tts/gptsovitsProvider";
import SettingDropdown from "./setting-dropdown";
import GptSovitsUploadManager from "./gptsovits-upload-manager";

export default function GptSovitsSettings() {
  const [voices, setVoices] = useState<TTSVoice[]>([]);
  const provider = ttsManager.getCurrentProviderInstance() as GPTSoVITSProvider;

  useEffect(() => {
    // Initial state
    setVoices(provider.getVoices());
    if (provider.getCurrentVoice() === null) {
      provider.setVoice(voices[0]?.name || "");
    }

    // Subscribe to changes
    const unsubscribe = provider.subscribe(() => {
      setVoices(provider.getVoices());
    });

    return unsubscribe;
  }, [provider]);

  const handleVoiceChange = async (voice: string) => {
    if (voice) {
        try {
        await provider.setVoice(voice);
        } catch (error) {
        console.error('Failed to change voice:', error);
        }
    }
  }

  // Convert voices array to options object
  const voiceOptions = Object.fromEntries(
    voices.map(voice => [voice.name, voice.displayName || voice.name])
  );
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>GPT-SoVITS Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <SettingDropdown
          id="tts.gptsovits.voice"
          defaultValue="leaf"
          label="Voice Model"
          options={voiceOptions}
          onValueChange={handleVoiceChange}
        />
        <GptSovitsUploadManager
          voices={voices}
          onVoicesChange={() => {
            provider.refreshVoices();
          }}
        />
      </CardContent>
    </Card>
  )
}