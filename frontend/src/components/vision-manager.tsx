import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import {
  Loader2,
  Camera,
  FileText,
  Image as ImageIcon,
  AlertCircle,
  Monitor,
  Zap,
  Play,
  Pause,
  Clock,
} from "lucide-react";
import { Panel } from "./panel";
import { chatManager } from "@/lib/chatManager";
import { SidePanel } from "./side-panel";
import { globalStateManager } from "@/lib/globalStateManager";

interface MonitorInfo {
  index: number;
  width: number;
  height: number;
  top: number;
  left: number;
  is_primary: boolean;
  description: string;
}

interface ScreenshotResponse {
  success: boolean;
  image: string;
  image_llm?: string;
  mime?: string;
  caption: string;
  extracted_text: string;
  ocr_count: number;
  ocr_results: Array<{
    text: string;
    bbox: number[][];
    confidence: number;
  }>;
  ocr_scale_factor: number;
  unchanged?: boolean;
  mode?: string;
  duration_ms?: number;
}

interface VisionManagerProps {
  className?: string;
}

export function VisionManager({ className }: VisionManagerProps) {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ScreenshotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState<number>(1);
  const [loadingMonitors, setLoadingMonitors] = useState(true);
  const [ocrScaleFactor, setOcrScaleFactor] = useState<number>(0.65);
  const [autoCapture, setAutoCapture] = useState(false);
  const [captureDelay, setCaptureDelay] = useState<number>(1.5);
  const [requestDuration, setRequestDuration] = useState<number | null>(null);
  const [skipOcr, setSkipOcr] = useState(false);
  const [includeCaption, setIncludeCaption] = useState(false);
  const [lastMode, setLastMode] = useState<string>("");
  const [unchangedHits, setUnchangedHits] = useState(0);

  const inFlightRef = useRef(false);
  const selectedMonitorRef = useRef(selectedMonitor);
  const ocrScaleRef = useRef(ocrScaleFactor);
  const skipOcrRef = useRef(skipOcr);
  const includeCaptionRef = useRef(includeCaption);

  useEffect(() => {
    selectedMonitorRef.current = selectedMonitor;
  }, [selectedMonitor]);
  useEffect(() => {
    ocrScaleRef.current = ocrScaleFactor;
  }, [ocrScaleFactor]);
  useEffect(() => {
    skipOcrRef.current = skipOcr;
  }, [skipOcr]);
  useEffect(() => {
    includeCaptionRef.current = includeCaption;
  }, [includeCaption]);

  useEffect(() => {
    const unsubscribe = globalStateManager.subscribe("isAutoCapture", (capture) => {
      setAutoCapture(capture);
    });
    setAutoCapture(globalStateManager.getState("isAutoCapture"));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const loadMonitors = async () => {
      try {
        const res = await fetch("/api/monitors");
        const data = await res.json();
        if (data.monitors) {
          // Skip "all monitors" (index 0) in the UI when possible
          const usable = data.monitors.filter((m: MonitorInfo) => m.index !== 0);
          const list = usable.length > 0 ? usable : data.monitors;
          setMonitors(list);
          const primary =
            list.find((m: MonitorInfo) => m.is_primary) ||
            list.find((m: MonitorInfo) => m.index === 1) ||
            list[0];
          if (primary) setSelectedMonitor(primary.index);
        }
      } catch (err) {
        console.error("Failed to load monitors:", err);
      } finally {
        setLoadingMonitors(false);
      }
    };
    loadMonitors();
  }, []);

  const captureScreenshot = useCallback(
    async (options: { mode?: "auto" | "rich" | "fast"; force?: boolean } = {}) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setLoading(true);
      setError(null);
      const startTime = Date.now();

      try {
        const mode = options.mode ?? "rich";
        const force = options.force ?? mode === "rich";
        const params = new URLSearchParams({
          monitor_index: String(selectedMonitorRef.current),
          ocr_scale_factor: String(ocrScaleRef.current),
          skip_ocr: String(skipOcrRef.current),
          skip_caption: String(!includeCaptionRef.current),
          mode,
          force: String(force),
          jpeg_quality: "72",
          preview_max_width: "1280",
          llm_image_max_width: "1024",
        });

        const res = await fetch(`/api/screenshot?${params.toString()}`);
        const data = await res.json();

        if (data.success) {
          setResponse(data);
          setLastMode(data.mode || mode);
          setUnchangedHits((prev) => (data.unchanged ? prev + 1 : 0));

          // OCR-first: always push text; caption is optional
          if (!skipOcrRef.current) {
            chatManager.setOcrPrompt(data.extracted_text || "");
          } else {
            chatManager.setOcrPrompt("");
          }
          chatManager.setVisionPrompt(data.caption || "");
          const imageForLlm = data.image_llm || data.image;
          if (imageForLlm) {
            chatManager.setCurrentImage(imageForLlm, data.mime || "image/jpeg");
          }
        } else {
          setError(data.error || "Failed to capture screenshot");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to capture screenshot");
      } finally {
        setRequestDuration(Date.now() - startTime);
        setLoading(false);
        inFlightRef.current = false;
      }
    },
    []
  );

  // Non-overlapping auto-capture loop (OCR-first auto mode + change detection)
  useEffect(() => {
    if (!autoCapture) return;

    let cancelled = false;
    const delayMs = Math.max(captureDelay * 1000, 800);

    const tick = async () => {
      if (cancelled) return;
      await captureScreenshot({ mode: "auto", force: false });
      if (cancelled) return;
      window.setTimeout(tick, delayMs);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [autoCapture, captureDelay, captureScreenshot]);

  const toggleAutoCapture = () => {
    globalStateManager.updateState("isAutoCapture", !autoCapture);
  };

  const getScaledResolution = () => {
    const selectedMonitorInfo = monitors.find((m) => m.index === selectedMonitor);
    if (!selectedMonitorInfo) return null;
    return {
      width: Math.round(selectedMonitorInfo.width * ocrScaleFactor),
      height: Math.round(selectedMonitorInfo.height * ocrScaleFactor),
    };
  };

  const scaledResolution = getScaledResolution();
  const previewSrc = response?.image
    ? `data:${response.mime || "image/jpeg"};base64,${response.image}`
    : null;

  return (
    <div className="relative h-full overflow-hidden">
      <SidePanel isOpen={true} width={400}>
        <div className="flex flex-col gap-2">
          <div className="space-y-2 w-full overflow-hidden">
            <label className="text-sm font-medium flex items-center gap-2">
              <Monitor className="h-4 w-4" />
              Select Monitor
            </label>
            {loadingMonitors ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading monitors...
              </div>
            ) : (
              <Select
                value={selectedMonitor.toString()}
                onValueChange={(value) => setSelectedMonitor(parseInt(value))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a monitor" />
                </SelectTrigger>
                <SelectContent>
                  {monitors.map((monitor) => (
                    <SelectItem key={monitor.index} value={monitor.index.toString()}>
                      {monitor.description}
                      {monitor.is_primary && " (Primary)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <Zap className="h-4 w-4" />
              OCR Scale Factor
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="0.1"
                max="1.0"
                step="0.05"
                value={ocrScaleFactor}
                onChange={(e) => setOcrScaleFactor(parseFloat(e.target.value) || 0.65)}
                className="w-20"
              />
              <span className="text-sm text-muted-foreground">
                ({Math.round(ocrScaleFactor * 100)}%)
              </span>
            </div>
            {scaledResolution && (
              <div className="text-xs text-muted-foreground">
                <p>~0.6–0.75 recommended for text accuracy vs speed</p>
                <p>
                  OCR resolution: {scaledResolution.width} × {scaledResolution.height}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <FileText className="h-4 w-4" />
              OCR Processing
            </label>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Extract on-screen text</span>
              <Switch checked={!skipOcr} onCheckedChange={(checked) => setSkipOcr(!checked)} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Also generate caption (slower)</span>
              <Switch checked={includeCaption} onCheckedChange={setIncludeCaption} />
            </div>
            <div className="text-xs text-muted-foreground">
              Auto mode skips re-OCR when the screen is unchanged.
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Auto-Capture Interval
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="0.8"
                max="30"
                step="0.1"
                value={captureDelay}
                onChange={(e) => setCaptureDelay(parseFloat(e.target.value) || 1.5)}
                className="w-16"
                disabled={autoCapture}
              />
              <span className="text-sm text-muted-foreground">seconds</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Default 1.5s. Lower values feel snappier but use more CPU/GPU.
            </div>
          </div>
        </div>
      </SidePanel>

      <div className="mx-auto flex max-w-4xl flex-col gap-4 overflow-y-auto scrollbar-themed pt-4 h-full px-4">
        <Panel>
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              OCR-first screen share: reads on-screen text accurately, caches when unchanged, and
              sends a compressed JPEG to vision models only when needed.
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => void captureScreenshot({ mode: "rich", force: true })}
                disabled={loading || loadingMonitors}
                className="flex-1"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Capturing...
                  </>
                ) : (
                  <>
                    <Camera className="mr-2 h-4 w-4" />
                    Capture + OCR Now
                  </>
                )}
              </Button>

              <Button
                onClick={toggleAutoCapture}
                variant={autoCapture ? "destructive" : "secondary"}
                disabled={loadingMonitors}
              >
                {autoCapture ? (
                  <>
                    <Pause className="mr-2 h-4 w-4" />
                    Stop Vision
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Start Vision
                  </>
                )}
              </Button>
            </div>

            {autoCapture && (
              <div className="rounded bg-muted p-2 text-sm text-muted-foreground">
                Auto vision running every {captureDelay}s · last mode: {lastMode || "—"}
                {unchangedHits > 0 ? ` · cache hits: ${unchangedHits}` : ""}
              </div>
            )}
          </div>
        </Panel>

        {error && (
          <Panel className="border-destructive">
            <div className="flex items-center gap-2 p-4 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
          </Panel>
        )}

        {response && (
          <Panel className={`space-y-6 ${className || ""}`}>
            <div>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ImageIcon className="h-5 w-5" />
                  Screenshot Preview
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="relative">
                  {previewSrc && (
                    <img
                      src={previewSrc}
                      alt="Screenshot"
                      className="w-full max-w-full rounded-lg border shadow-sm"
                    />
                  )}
                  <div className="absolute top-2 right-2 flex gap-2">
                    {response.unchanged && <Badge className="bg-black/70 text-white">Cached</Badge>}
                    <Badge className="bg-black/70 text-white">
                      {skipOcr ? "OCR off" : `${response.ocr_count} text regions`}
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </div>

            {!skipOcr && (
              <div>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Extracted Text (OCR)
                  </CardTitle>
                  <CardDescription>
                    {response.ocr_count} regions · primary context for the AI
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="rounded-lg bg-muted p-3">
                    <p className="whitespace-pre-wrap text-sm">
                      {response.extracted_text || "No text detected"}
                    </p>
                  </div>
                </CardContent>
              </div>
            )}

            {response.caption && (
              <div>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Caption
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-relaxed">{response.caption}</p>
                </CardContent>
              </div>
            )}

            <div>
              <CardHeader>
                <CardTitle>Capture Details</CardTitle>
              </CardHeader>
              <div className="grid grid-cols-2 gap-4 p-5 text-sm">
                <div>
                  <span className="font-medium">Mode:</span>
                  <span className="ml-2">{response.mode || "—"}</span>
                </div>
                <div>
                  <span className="font-medium">Duration:</span>
                  <span className="ml-2">
                    {response.duration_ms ?? requestDuration ?? "—"}
                    {(response.duration_ms ?? requestDuration) != null ? "ms" : ""}
                  </span>
                </div>
                <div>
                  <span className="font-medium">Unchanged:</span>
                  <span className="ml-2">{response.unchanged ? "Yes (cache)" : "No"}</span>
                </div>
                <div>
                  <span className="font-medium">Format:</span>
                  <span className="ml-2">{response.mime || "image/jpeg"}</span>
                </div>
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
