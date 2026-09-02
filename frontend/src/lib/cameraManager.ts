type CameraListener = (state: CameraState) => void;

export interface CameraState {
  enabled: boolean;
  ready: boolean;
  deviceId: string;
  error: string | null;
  lastFrameAt: number | null;
}

class CameraManager {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private enabled = false;
  private ready = false;
  private deviceId = "";
  private error: string | null = null;
  private lastFrameAt: number | null = null;
  private listeners = new Set<CameraListener>();
  private starting: Promise<boolean> | null = null;

  subscribe(listener: CameraListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): CameraState {
    return {
      enabled: this.enabled,
      ready: this.ready,
      deviceId: this.deviceId,
      error: this.error,
      lastFrameAt: this.lastFrameAt,
    };
  }

  private notify() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  isReady() {
    return this.enabled && this.ready && !!this.video;
  }

  getVideoElement() {
    return this.video;
  }

  async setDeviceId(deviceId: string) {
    this.deviceId = deviceId === "default" ? "" : deviceId;
    if (this.enabled) {
      await this.start(this.deviceId);
    } else {
      this.notify();
    }
  }

  async setEnabled(enabled: boolean) {
    if (enabled) {
      return this.start(this.deviceId);
    }
    this.stop();
    return false;
  }

  async start(deviceId?: string): Promise<boolean> {
    if (deviceId !== undefined) {
      this.deviceId = deviceId === "default" ? "" : deviceId;
    }
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.error = "Camera API not available in this browser";
        this.enabled = false;
        this.ready = false;
        this.notify();
        return false;
      }

      this.stopTracksOnly();

      const constraints: MediaStreamConstraints = {
        audio: false,
        video: this.deviceId
          ? { deviceId: { exact: this.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.stream = stream;
        if (!this.video) {
          this.video = document.createElement("video");
          this.video.muted = true;
          this.video.playsInline = true;
          this.video.setAttribute("playsinline", "true");
        }
        this.video.srcObject = stream;
        await this.video.play();
        // Wait for a real frame
        if (this.video.readyState < 2) {
          await new Promise<void>((resolve) => {
            const onReady = () => {
              this.video?.removeEventListener("loadeddata", onReady);
              resolve();
            };
            this.video?.addEventListener("loadeddata", onReady);
          });
        }
        this.enabled = true;
        this.ready = true;
        this.error = null;
        this.notify();
        return true;
      } catch (err) {
        this.enabled = false;
        this.ready = false;
        this.error = err instanceof Error ? err.message : "Failed to open camera";
        this.notify();
        return false;
      } finally {
        this.starting = null;
      }
    })();

    return this.starting;
  }

  private stopTracksOnly() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
    }
    this.ready = false;
  }

  stop() {
    this.stopTracksOnly();
    this.enabled = false;
    this.error = null;
    this.notify();
  }

  /**
   * Capture current webcam frame as JPEG base64 (no data: prefix).
   */
  captureJpegBase64(maxWidth = 1024, quality = 0.82): string | null {
    const video = this.video;
    if (!this.enabled || !video || video.videoWidth < 2 || video.videoHeight < 2) {
      return null;
    }

    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    this.lastFrameAt = Date.now();
    this.notify();
    const base64 = dataUrl.split(",", 2)[1];
    return base64 || null;
  }

  attachPreview(videoEl: HTMLVideoElement | null) {
    if (!videoEl) return;
    if (this.stream) {
      videoEl.srcObject = this.stream;
      void videoEl.play().catch(() => undefined);
    }
  }
}

export const cameraManager = new CameraManager();
