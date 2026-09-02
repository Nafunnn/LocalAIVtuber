"""Create placeholder reference.wav files for bundled TTS voices."""
import json
import os
import wave
import struct

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend", "services", "TTS", "GPTsovits", "models"))

def create_wav(path: str, duration_sec: float = 3.0, sample_rate: int = 44100):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    n_frames = int(sample_rate * duration_sec)
    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        # Quiet sine tone placeholder
        import math
        for i in range(n_frames):
            val = int(800 * math.sin(2 * math.pi * 220 * i / sample_rate))
            wf.writeframes(struct.pack("<h", val))

for voice in os.listdir(ROOT):
    voice_dir = os.path.join(ROOT, voice)
    meta_path = os.path.join(voice_dir, "metadata.json")
    if not os.path.isdir(voice_dir) or not os.path.exists(meta_path):
        continue
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    audio_file = meta.get("audio_file", "reference.wav")
    wav_path = os.path.join(voice_dir, audio_file)
    if not os.path.exists(wav_path):
        print(f"Creating placeholder: {wav_path}")
        create_wav(wav_path)
    else:
        print(f"Exists: {wav_path}")

print("Done.")
