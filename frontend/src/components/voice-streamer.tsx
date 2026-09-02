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
import { voiceInputManager, type VoiceInputState } from "@/lib/voiceInputManager";
import { useSettings } from "@/context/SettingsContext";

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
const LANGUAGE_SETTING = "input.language";

export default function VoiceStreamer() {
  const { settings, updateSetting } = useSettings();
  const [voiceState, setVoiceState] = useState<VoiceInputState>(voiceInputManager.getState());
  const [transcriptions, setTranscriptions] = useState<string[]>(voiceInputManager.getTranscriptions());
  const [microphones, setMicrophones] = useState<MicrophoneDevice[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const selectedMic =
    settings[MICROPHONE_SETTING] !== undefined && settings[MICROPHONE_SETTING] !== null
      ? String(settings[MICROPHONE_SETTING])
      : "default";
  const selectedCamera = settings[CAMERA_SETTING] || "default";
  const selectedLanguage = settings[LANGUAGE_SETTING] || "en";

  useEffect(() => {
    return voiceInputManager.subscribe((state) => {
      setVoiceState(state);
      setTranscriptions(voiceInputManager.getTranscriptions());
    });
  }, []);

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

  const startCameraPreview = useCallback(async (deviceId: string) => {
    if (!navigator.mediaDevices?.getUserMedia) return;

    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());

    const constraints: MediaStreamConstraints = {
      video: deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      await loadCameras();
    } catch {
      // Preview is optional.
    }
  }, [loadCameras]);

  useEffect(() => {
    startCameraPreview(selectedCamera);
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    };
  }, [selectedCamera, startCameraPreview]);

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
  };

  const handleLanguageChange = async (value: string) => {
    await updateSetting(LANGUAGE_SETTING, value);
  };

  const isRecording = voiceState.recording;

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
            <Label htmlFor="camera-select">Camera</Label>
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
            <div className="overflow-hidden rounded-md border bg-black/40 aspect-video max-h-48">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                muted
                playsInline
              />
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
