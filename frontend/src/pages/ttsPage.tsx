import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Settings } from "lucide-react"
import RvcSettings from "@/components/rvc-settings"
import GptSovitsSettings from "@/components/gptsovits-settings"
import { TextInputPreview } from "@/components/text-input-preview"
import { ttsManager } from "@/lib/ttsManager"
import SettingDropdown from "@/components/setting-dropdown"

type TTSProvider = "gpt-sovits" | "rvc"

export default function TTSPage() {
  const [selectedProvider, setSelectedProvider] = useState<TTSProvider>(ttsManager.getSelectedProvider())

  useEffect(() => {
    const unsubscribe = ttsManager.subscribe(() => {
      setSelectedProvider(ttsManager.getSelectedProvider())
    })
    return unsubscribe
  }, [])

  const handleProviderChange = async (value: string) => {
    await ttsManager.setSelectedProvider(value as TTSProvider)
  }

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br p-4">
      <div className="mx-auto max-w-4xl space-y-6">
        <TextInputPreview />

        {/* Provider Selection */}
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              TTS Provider Selection
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SettingDropdown id="tts.provider" defaultValue="gpt-sovits" options={{ "gpt-sovits": "GPT-SoVITS", "rvc": "RVC (Retrieval-based-Voice-Conversion)" }} onValueChange={handleProviderChange} />
          </CardContent>
        </Card>

        {/* Provider-specific Settings */}
        {selectedProvider === "gpt-sovits" && <GptSovitsSettings />}
        {selectedProvider === "rvc" && <RvcSettings />}
      </div>
    </div>
  )
}