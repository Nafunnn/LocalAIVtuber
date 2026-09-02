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
    setVoices(provider.getVoices());

    const unsubscribe = provider.subscribe(() => {
      const loadedVoices = provider.getVoices();
      setVoices(loadedVoices);
      if (provider.getCurrentVoice() === null && loadedVoices[0]?.name) {
        void provider.setVoice(loadedVoices[0].name);
      }
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