import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Panel } from "./panel";
import { ScrollArea } from "@radix-ui/react-scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { voiceInputManager, type VoiceInputState } from "@/lib/voiceInputManager";
import { cameraManager, type CameraState } from "@/lib/cameraManager";
import {
  cameraPresenceWatcher,
  type CameraPresenceState,
} from "@/lib/cameraPresenceWatcher";
import { chatManager } from "@/lib/chatManager";
import { useSettings } from "@/context/SettingsContext";
import { Camera } from "lucide-react";

interface MicrophoneDevice {
  index: number;
  name: string;
  channels: number;
  sample_rate: number;
  is_default: boolean;
}

interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

const MICROPHONE_SETTING = "input.microphone.device";
const CAMERA_SETTING = "input.camera.deviceId";
const CAMERA_ENABLED_SETTING = "input.camera.enabled";
const PRESENCE_WATCH_SETTING = "input.camera.presenceWatch.enabled";
const PRESENCE_COOLDOWN_SETTING = "input.camera.presenceWatch.cooldownMinutes";
const LANGUAGE_SETTING = "input.language";

export default function VoiceStreamer() {
  const { settings, updateSetting } = useSettings();
  const [voiceState, setVoiceState] = useState<VoiceInputState>(voiceInputManager.getState());
  const [cameraState, setCameraState] = useState<CameraState>(cameraManager.getState());
  const [presenceState, setPresenceState] = useState<CameraPresenceState>(
    cameraPresenceWatcher.getState()
  );
  const [transcriptions, setTranscriptions] = useState<string[]>(voiceInputManager.getTranscriptions());
  const [microphones, setMicrophones] = useState<MicrophoneDevice[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  const selectedMic =
    settings[MICROPHONE_SETTING] !== undefined && settings[MICROPHONE_SETTING] !== null
      ? String(settings[MICROPHONE_SETTING])
      : "default";
  const selectedCamera = settings[CAMERA_SETTING] || "default";
  const cameraShareEnabled = Boolean(settings[CAMERA_ENABLED_SETTING]);
  const presenceWatchEnabled = Boolean(settings[PRESENCE_WATCH_SETTING]);
  const presenceCooldownMinutes =
    typeof settings[PRESENCE_COOLDOWN_SETTING] === "number"
      ? settings[PRESENCE_COOLDOWN_SETTING]
      : 5;
  const selectedLanguage = settings[LANGUAGE_SETTING] || "en";

  useEffect(() => {
    return voiceInputManager.subscribe((state) => {
      setVoiceState(state);
      setTranscriptions(voiceInputManager.getTranscriptions());
    });
  }, []);

  useEffect(() => {
    return cameraManager.subscribe((state) => {
      setCameraState(state);
      cameraManager.attachPreview(videoRef.current);
    });
  }, []);

  useEffect(() => {
    return cameraPresenceWatcher.subscribe(setPresenceState);
  }, []);

  useEffect(() => {
    cameraManager.attachPreview(videoRef.current);
  }, [cameraState.ready, cameraState.enabled]);

  const loadMicrophones = useCallback(async () => {
    const response = await fetch("/api/input/microphones");
    const data = await response.json();
    if (response.ok) {
      setMicrophones(data.microphones ?? []);
    }
  }, []);

  const loadCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameras([]);
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      setCameras(videoInputs);
    } catch {
      // Camera list is optional for voice input.
    }
  }, []);

  useEffect(() => {
    const loadDevices = async () => {
      setLoadingDevices(true);
      try {
        await Promise.all([loadMicrophones(), loadCameras()]);
      } finally {
        setLoadingDevices(false);
      }
    };
    loadDevices();
  }, [loadMicrophones, loadCameras]);

  const handleMicrophoneChange = async (value: string) => {
    const index = value === "default" ? null : Number(value);
    const response = await fetch("/api/input/microphone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    if (!response.ok) return;
    await updateSetting(MICROPHONE_SETTING, index);
  };

  const handleCameraChange = async (value: string) => {
    const deviceId = value === "default" ? "" : value;
    await updateSetting(CAMERA_SETTING, deviceId);
    await cameraManager.setDeviceId(deviceId);
    await loadCameras();
  };

  const handleCameraShareToggle = async (enabled: boolean) => {
    await updateSetting(CAMERA_ENABLED_SETTING, enabled);
    const ok = await cameraManager.setEnabled(enabled);
    if (ok) {
      await loadCameras();
      cameraManager.attachPreview(videoRef.current);
    }
    if (!enabled && presenceWatchEnabled) {
      await updateSetting(PRESENCE_WATCH_SETTING, false);
    }
  };

  const handlePresenceWatchToggle = async (enabled: boolean) => {
    if (enabled && !cameraShareEnabled) {
      await updateSetting(CAMERA_ENABLED_SETTING, true);
      const ok = await cameraManager.setEnabled(true);
      if (ok) {
        await loadCameras();
        cameraManager.attachPreview(videoRef.current);
      }
    }
    await updateSetting(PRESENCE_WATCH_SETTING, enabled);
  };

  const handlePresenceCooldownChange = async (value: string) => {
    const minutes = Math.max(1, Math.min(60, Number(value) || 5));
    await updateSetting(PRESENCE_COOLDOWN_SETTING, minutes);
  };

  const handleLanguageChange = async (value: string) => {
    await updateSetting(LANGUAGE_SETTING, value);
  };

  const [capturing, setCapturing] = useState(false);
  const isRecording = voiceState.recording;

  const handleCaptureForAi = async () => {
    if (!cameraState.enabled || !cameraState.ready || capturing) return;
    setCapturing(true);
    try {
      const ok = await chatManager.sendCameraSnapshot(
        "Please look at this camera photo of me and describe what you see warmly and specifically."
      );
      if (!ok) {
        window.alert('Camera is not ready. Enable "Share camera with AI" first.');
      }
    } finally {
      setCapturing(false);
    }
  };

  return (
    <Panel className="max-w-4xl mx-auto">
      <h2 className="text-xl font-bold mb-4">Voice Input</h2>
      <div className="flex flex-col gap-4">
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Global shortcut: hold{" "}
          <kbd className="rounded border px-1 py-0.5 font-mono text-[11px]">Ctrl</kbd>
          {" + "}
          <kbd className="rounded border px-1 py-0.5 font-mono text-[11px]">Space</kbd>
          {" anywhere (including Character page) to talk to the AI + 3D model. Your entire message is sent once when you release the keys."}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="microphone-select">Microphone</Label>
            <Select
              value={selectedMic}
              onValueChange={handleMicrophoneChange}
              disabled={loadingDevices || isRecording}
            >
              <SelectTrigger id="microphone-select">
                <SelectValue placeholder={loadingDevices ? "Loading..." : "Select microphone"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">System default</SelectItem>
                {microphones.map((mic) => (
                  <SelectItem key={mic.index} value={String(mic.index)}>
                    {mic.name}{mic.is_default ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="language-select">Speech language</Label>
            <Select
              value={selectedLanguage}
              onValueChange={handleLanguageChange}
              disabled={isRecording}
            >
              <SelectTrigger id="language-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="auto">Auto detect</SelectItem>
                <SelectItem value="id">Indonesian</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Label htmlFor="camera-select">Camera</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Enable share so the AI can see you and describe how you look.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="camera-share-toggle" className="text-sm font-normal">
                  Share camera with AI
                </Label>
                <Switch
                  id="camera-share-toggle"
                  checked={cameraShareEnabled}
                  onCheckedChange={handleCameraShareToggle}
                />
              </div>
            </div>
            <Select
              value={selectedCamera || "default"}
              onValueChange={handleCameraChange}
            >
              <SelectTrigger id="camera-select">
                <SelectValue placeholder={loadingDevices ? "Loading..." : "Select camera"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">System default</SelectItem>
                {cameras.map((camera) => (
                  <SelectItem key={camera.deviceId || camera.label} value={camera.deviceId || "default"}>
                    {camera.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="overflow-hidden rounded-md border bg-black/40 aspect-video max-h-48 relative">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                muted
                playsInline
              />
              {!cameraState.enabled && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground bg-black/50 px-4 text-center">
                  Camera share off — turn on “Share camera with AI” to let the model see you
                </div>
              )}
            </div>
            {cameraState.error && (
              <p className="text-sm text-destructive">{cameraState.error}</p>
            )}
            {cameraState.enabled && cameraState.ready && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleCaptureForAi()}
                  disabled={capturing}
                >
                  <Camera className="mr-1.5 h-4 w-4" />
                  {capturing ? "Capturing…" : "Take photo for AI"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Live — ask “Can you see me?” / “Ambil foto aku” or use this button
                </p>
              </div>
            )}

            <div className="rounded-md border bg-muted/30 px-3 py-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Label htmlFor="presence-watch-toggle" className="text-sm">
                    Watch for person entering
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    When the room is empty and someone enters the frame, the AI greets you
                    proactively (uses object detection + scene change).
                  </p>
                </div>
                <Switch
                  id="presence-watch-toggle"
                  checked={presenceWatchEnabled}
                  onCheckedChange={(v) => void handlePresenceWatchToggle(v)}
                  disabled={loadingDevices}
                />
              </div>
              {presenceWatchEnabled && (
                <div className="flex flex-wrap items-center gap-3">
                  <Label htmlFor="presence-cooldown" className="text-xs shrink-0">
                    Greeting cooldown (minutes)
                  </Label>
                  <Select
                    value={String(presenceCooldownMinutes)}
                    onValueChange={(v) => void handlePresenceCooldownChange(v)}
                  >
                    <SelectTrigger id="presence-cooldown" className="h-8 w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 3, 5, 10, 15, 30].map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {presenceState.modelReady
                      ? presenceState.personVisible
                        ? "Person in frame"
                        : presenceState.scanning
                          ? "Scanning — waiting for someone to enter"
                          : "Model ready"
                      : presenceState.error
                        ? `Detection unavailable: ${presenceState.error}`
                        : "Loading detection model… (first run downloads weights)"}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
          <Button
            variant={isRecording ? "destructive" : "outline"}
            onClick={() => {
              if (isRecording) {
                void voiceInputManager.stopRecording();
              } else {
                void voiceInputManager.startRecording();
              }
            }}
            disabled={loadingDevices}
          >
            {isRecording ? "Stop Voice" : "Start Voice"}
          </Button>
          <div className="w-full">
            <p className="text-sm mb-1">Speech Probability</p>
            <div className="w-full bg-gray-500 rounded-full h-2">
              <div
                className="bg-accent-foreground h-2 rounded-full transition-all"
                style={{ width: `${(voiceState.probability ?? 0) * 100}%` }}
              />
            </div>
            <p className="text-xs mt-1 text-right">
              {`${(voiceState.probability * 100).toFixed(2)}%`}
            </p>
          </div>
        </div>

        {voiceState.status && (
          <p className="text-sm text-muted-foreground">{voiceState.status}</p>
        )}
        {voiceState.error && (
          <p className="text-sm text-destructive">{voiceState.error}</p>
        )}

        <Panel className="h-186">
          <ScrollArea className="h-full overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transcriptions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...transcriptions].reverse().map((text, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{text}</TableCell>
                  </TableRow>
                ))}
                {transcriptions.length === 0 && (
                  <TableRow>
                    <TableCell className="text-muted-foreground">No transcriptions yet</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </Panel>
      </div>
    </Panel>
  );
}
