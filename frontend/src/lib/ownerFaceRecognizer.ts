import * as faceapi from "@vladmandic/face-api";

const MODEL_URL =
  "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
export const DEFAULT_OWNER_MATCH_THRESHOLD = 0.55;
export const OWNER_ENROLLMENT_SAMPLES = 3;

export type OwnerFaceVerifyResult = {
  matched: boolean;
  distance: number;
  faceDetected: boolean;
  enrolled: boolean;
};

export type OwnerFaceState = {
  modelReady: boolean;
  enrolled: boolean;
  embeddingCount: number;
  matchThreshold: number;
  error: string | null;
};

type OwnerFaceListener = (state: OwnerFaceState) => void;

export function serializeEmbeddings(embeddings: Float32Array[]): number[][] {
  return embeddings.map((row) => Array.from(row));
}

export function deserializeEmbeddings(data: unknown): Float32Array[] {
  if (!Array.isArray(data)) return [];
  const result: Float32Array[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 64) continue;
    const nums = row.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (nums.length >= 64) result.push(new Float32Array(nums));
  }
  return result;
}

class OwnerFaceRecognizer {
  private loaded = false;
  private loading: Promise<boolean> | null = null;
  private referenceEmbeddings: Float32Array[] = [];
  private matchThreshold = DEFAULT_OWNER_MATCH_THRESHOLD;
  private error: string | null = null;
  private listeners = new Set<OwnerFaceListener>();
  private detectOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: 320,
    scoreThreshold: 0.5,
  });

  subscribe(listener: OwnerFaceListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): OwnerFaceState {
    return {
      modelReady: this.loaded,
      enrolled: this.referenceEmbeddings.length > 0,
      embeddingCount: this.referenceEmbeddings.length,
      matchThreshold: this.matchThreshold,
      error: this.error,
    };
  }

  private notify() {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  setReferenceEmbeddings(embeddings: Float32Array[]) {
    this.referenceEmbeddings = embeddings;
    this.notify();
  }

  setMatchThreshold(threshold: number) {
    this.matchThreshold = Math.max(0.35, Math.min(0.75, threshold));
    this.notify();
  }

  isEnrolled() {
    return this.referenceEmbeddings.length > 0;
  }

  async ensureModels(): Promise<boolean> {
    if (this.loaded) return true;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        this.loaded = true;
        this.error = null;
        return true;
      } catch (err) {
        this.error =
          err instanceof Error ? err.message : "Face recognition model failed to load";
        console.warn("Owner face models unavailable:", err);
        return false;
      } finally {
        this.loading = null;
        this.notify();
      }
    })();

    return this.loading;
  }

  private minDistance(descriptor: Float32Array): number {
    let min = Infinity;
    for (const ref of this.referenceEmbeddings) {
      const d = faceapi.euclideanDistance(descriptor, ref);
      if (d < min) min = d;
    }
    return min;
  }

  async captureEmbedding(
    input: HTMLVideoElement | HTMLCanvasElement
  ): Promise<Float32Array | null> {
    const ok = await this.ensureModels();
    if (!ok) return null;

    const detection = await faceapi
      .detectSingleFace(input, this.detectOptions)
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    return detection?.descriptor ?? null;
  }

  async enrollFromVideo(
    video: HTMLVideoElement,
    samples = OWNER_ENROLLMENT_SAMPLES,
    delayMs = 700
  ): Promise<Float32Array[]> {
    const captured: Float32Array[] = [];
    for (let i = 0; i < samples; i += 1) {
      const embedding = await this.captureEmbedding(video);
      if (embedding) captured.push(embedding);
      if (i < samples - 1) {
        await new Promise((r) => window.setTimeout(r, delayMs));
      }
    }
    if (captured.length > 0) {
      this.referenceEmbeddings = captured;
      this.notify();
    }
    return captured;
  }

  async verifyOwner(
    input: HTMLVideoElement | HTMLCanvasElement
  ): Promise<OwnerFaceVerifyResult> {
    const enrolled = this.referenceEmbeddings.length > 0;
    if (!enrolled) {
      return { matched: false, distance: Infinity, faceDetected: false, enrolled: false };
    }

    const ok = await this.ensureModels();
    if (!ok) {
      return { matched: false, distance: Infinity, faceDetected: false, enrolled: true };
    }

    try {
      const detection = await faceapi
        .detectSingleFace(input, this.detectOptions)
        .withFaceLandmarks(true)
        .withFaceDescriptor();

      if (!detection) {
        return { matched: false, distance: Infinity, faceDetected: false, enrolled: true };
      }

      const distance = this.minDistance(detection.descriptor);
      return {
        matched: distance <= this.matchThreshold,
        distance,
        faceDetected: true,
        enrolled: true,
      };
    } catch (err) {
      console.warn("Owner face verification failed:", err);
      return { matched: false, distance: Infinity, faceDetected: false, enrolled: true };
    }
  }

  clearEnrollment() {
    this.referenceEmbeddings = [];
    this.notify();
  }
}

export const ownerFaceRecognizer = new OwnerFaceRecognizer();
