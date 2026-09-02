import asyncio
import os
import queue
import time
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import sounddevice as sd
import torch
from faster_whisper import WhisperModel
from silero_vad import load_silero_vad, VADIterator

from ..lib.LAV_logger import logger


class VoiceInput:
    current_module_directory = os.path.dirname(__file__)
    MIC_OUTPUT_PATH = os.path.join(current_module_directory, "voice_recording.wav")

    SAMPLING_RATE = 16000
    BLOCK_SIZE = 4096
    AUDIO_QUEUE_SIZE = 64
    PROB_BROADCAST_INTERVAL = 0.05

    input_language = "en"
    input_device: int | None = None
    whisper_filter_list = [
        "you", "thank you.", "thanks for watching.", "thanks for watching!", "Thank you for watching.",
        "1.5%", "I'm going to put it in the fridge.", "I", ".", "okay.", "bye.", "so,", "I'm sorry."
    ]
    SPEECH_THRESHOLD = 0.3
    SILENCE_WAIT_TIME = 0.7 * SAMPLING_RATE
    PRE_SPEECH_SAMPLES = 0.5 * SAMPLING_RATE
    POST_SPEECH_SAMPLES = 0.5 * SAMPLING_RATE

    vad_model = load_silero_vad()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    whisper_model = WhisperModel("medium", device=device)

    vad_iterator = VADIterator(vad_model, sampling_rate=SAMPLING_RATE)
    running = False
    _transcribe_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")

    def __init__(self):
        self._reset_buffers()
        self.last_transcription = None
        self.clients: set = set()
        self._audio_queue: queue.Queue = queue.Queue(maxsize=self.AUDIO_QUEUE_SIZE)
        self._last_prob_broadcast = 0.0
        self._processor_task: asyncio.Task | None = None
        self.batch_until_stop = False
        self.session_audio_buffer: list[float] = []

    @staticmethod
    def list_microphones() -> list[dict]:
        devices = sd.query_devices()
        default_input = sd.default.device[0]
        microphones = []
        for index, device in enumerate(devices):
            if device["max_input_channels"] > 0:
                microphones.append({
                    "index": index,
                    "name": device["name"],
                    "channels": device["max_input_channels"],
                    "sample_rate": device["default_samplerate"],
                    "is_default": index == default_input,
                })
        return microphones

    def set_input_device(self, device_index: int | None):
        self.input_device = device_index
        logger.info(f"Microphone device set to: {device_index if device_index is not None else 'default'}")

    def set_input_language(self, language: str):
        self.input_language = language or "en"
        logger.info(f"Input language set to: {self.input_language}")

    async def _broadcast(self, payload: dict):
        if not self.clients:
            return
        await asyncio.gather(*[
            client.send_json(payload)
            for client in list(self.clients)
        ], return_exceptions=True)

    async def _emit_transcription(self, transcribed_text: str):
        cleaned = transcribed_text.strip()
        if not cleaned or cleaned.lower() in self.whisper_filter_list:
            return
        if cleaned == self.last_transcription:
            return
        self.last_transcription = cleaned
        logger.info(f"Voice transcription: {cleaned}")
        await self._broadcast({"type": "transcription", "text": cleaned})

    def _enqueue_audio(self, indata):
        try:
            self._audio_queue.put_nowait(indata.copy())
        except queue.Full:
            try:
                self._audio_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._audio_queue.put_nowait(indata.copy())
            except queue.Full:
                logger.warning("Audio queue full, dropping input chunk")

    async def _transcribe_async(self, audio_data: np.ndarray) -> str | None:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._transcribe_executor,
            self.process_speech,
            audio_data,
        )

    async def _flush_pending_speech(self):
        if self.batch_until_stop:
            if len(self.session_audio_buffer) < 512:
                self.session_audio_buffer = []
                self._reset_buffers()
                return
            try:
                transcribed_text = await self._transcribe_async(np.array(self.session_audio_buffer))
                if transcribed_text:
                    await self._emit_transcription(transcribed_text)
                else:
                    logger.info("No speech detected in push-to-talk session")
            except Exception as exc:
                logger.error(f"Failed to flush push-to-talk speech: {exc}", exc_info=True)
                await self._broadcast({"type": "error", "message": "Failed to transcribe recorded speech"})
            finally:
                self.session_audio_buffer = []
                self.vad_iterator.reset_states()
                self._reset_buffers()
            return

        if not self.started_speaking or len(self.sentence_audio_buffer) < 512:
            self._reset_buffers()
            return

        try:
            transcribed_text = await self._transcribe_async(np.array(self.sentence_audio_buffer))
            if transcribed_text:
                await self._emit_transcription(transcribed_text)
            else:
                logger.info("No speech detected in final audio buffer")
        except Exception as exc:
            logger.error(f"Failed to flush pending speech: {exc}", exc_info=True)
            await self._broadcast({"type": "error", "message": "Failed to transcribe recorded speech"})
        finally:
            self.vad_iterator.reset_states()
            self._reset_buffers()

    def _reset_buffers(self):
        self.sentence_audio_buffer = []
        self.tmp_audio_buffer = []
        self.silent_samples = 0
        self.started_speaking = False

    async def _audio_processor(self):
        while self.running or not self._audio_queue.empty():
            processed_any = False
            while True:
                try:
                    indata = self._audio_queue.get_nowait()
                except queue.Empty:
                    break
                audio_np = indata.flatten().astype(np.float32) / 32768.0
                await self._process_audio(audio_np)
                processed_any = True

            if not processed_any:
                await asyncio.sleep(0.005)

    async def start_streaming(self, clients, batch_until_stop: bool = False):
        if self.running:
            return
        self.running = True
        self.batch_until_stop = batch_until_stop
        self.clients = clients
        self.session_audio_buffer = []
        self._reset_buffers()
        self.last_transcription = None
        while not self._audio_queue.empty():
            try:
                self._audio_queue.get_nowait()
            except queue.Empty:
                break

        logger.info(
            f"Started recording (device={self.input_device if self.input_device is not None else 'default'}, "
            f"clients={len(clients)}, batch_until_stop={batch_until_stop})"
        )

        def audio_callback(indata, frames, time_info, status):
            if status:
                logger.warning(f"Audio input status: {status}")
            self._enqueue_audio(indata)

        stream_kwargs = {
            "samplerate": self.SAMPLING_RATE,
            "channels": 1,
            "dtype": "int16",
            "callback": audio_callback,
            "blocksize": self.BLOCK_SIZE,
            "latency": "high",
        }
        if self.input_device is not None:
            stream_kwargs["device"] = self.input_device

        self._processor_task = asyncio.create_task(self._audio_processor())

        try:
            with sd.InputStream(**stream_kwargs):
                while self.running:
                    await asyncio.sleep(0.05)
        except Exception as exc:
            logger.error(f"Microphone stream failed: {exc}", exc_info=True)
            await self._broadcast({"type": "error", "message": str(exc)})
        finally:
            self.running = False
            if self._processor_task:
                await self._processor_task
                self._processor_task = None
            await self._flush_pending_speech()
            logger.info("Stopped recording")

    def stop_streaming(self):
        self.running = False

    async def _process_audio(self, audio_np):
        if self.batch_until_stop:
            self.session_audio_buffer.extend(audio_np.tolist())

            self.tmp_audio_buffer.extend(audio_np)
            while len(self.tmp_audio_buffer) >= 512:
                chunk = np.array(self.tmp_audio_buffer[:512])
                self.tmp_audio_buffer = self.tmp_audio_buffer[512:]

                with torch.inference_mode():
                    speech_prob = self.vad_model(torch.from_numpy(chunk), self.SAMPLING_RATE).item()

                now = time.monotonic()
                if now - self._last_prob_broadcast >= self.PROB_BROADCAST_INTERVAL:
                    self._last_prob_broadcast = now
                    await self._broadcast({"type": "probability", "probability": speech_prob})
            return

        self.tmp_audio_buffer.extend(audio_np)

        while len(self.tmp_audio_buffer) >= 512:
            chunk = np.array(self.tmp_audio_buffer[:512])
            self.tmp_audio_buffer = self.tmp_audio_buffer[512:]

            with torch.inference_mode():
                speech_prob = self.vad_model(torch.from_numpy(chunk), self.SAMPLING_RATE).item()

            now = time.monotonic()
            if now - self._last_prob_broadcast >= self.PROB_BROADCAST_INTERVAL:
                self._last_prob_broadcast = now
                await self._broadcast({"type": "probability", "probability": speech_prob})

            if speech_prob < self.SPEECH_THRESHOLD:
                if self.silent_samples <= self.SILENCE_WAIT_TIME:
                    self.silent_samples += 512
            else:
                self.silent_samples = 0
                if not self.started_speaking:
                    pre = self.sentence_audio_buffer[-int(self.PRE_SPEECH_SAMPLES):]
                    self.sentence_audio_buffer = list(pre)
                self.started_speaking = True

            if self.started_speaking:
                self.sentence_audio_buffer.extend(chunk)

            if self.started_speaking and self.silent_samples > self.SILENCE_WAIT_TIME:
                post = self.tmp_audio_buffer[:int(self.POST_SPEECH_SAMPLES)]
                self.sentence_audio_buffer.extend(post)

                transcribed_text = await self._transcribe_async(np.array(self.sentence_audio_buffer))
                if transcribed_text:
                    await self._emit_transcription(transcribed_text)

                self.vad_iterator.reset_states()
                self._reset_buffers()

    def process_speech(self, audio_data):
        with wave.open(self.MIC_OUTPUT_PATH, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes((audio_data * 32768.0).astype(np.int16).tobytes())

        transcribed_text = ""
        language = None if self.input_language == "auto" else self.input_language
        segments, _ = self.whisper_model.transcribe(self.MIC_OUTPUT_PATH, language=language)
        for segment in segments:
            transcribed_text += segment.text

        cleaned = transcribed_text.strip()
        if not cleaned or cleaned.lower() in self.whisper_filter_list:
            return None
        return cleaned

    def run_cli(self):
        print("Running in CLI mode. Press Ctrl+C to stop.")
        loop = asyncio.get_event_loop()

        def audio_callback(indata, frames, time_info, status):
            audio_np = indata.flatten().astype(np.float32) / 32768.0
            loop.call_soon_threadsafe(lambda: asyncio.create_task(self._process_audio_cli(audio_np)))

        with sd.InputStream(
            samplerate=self.SAMPLING_RATE,
            channels=1,
            dtype="int16",
            callback=audio_callback,
            blocksize=self.BLOCK_SIZE,
            latency="high",
        ):
            try:
                loop.run_forever()
            except KeyboardInterrupt:
                print("Stopped recording.")

    async def _process_audio_cli(self, audio_np):
        self.tmp_audio_buffer.extend(audio_np)

        while len(self.tmp_audio_buffer) >= 512:
            chunk = np.array(self.tmp_audio_buffer[:512])
            self.tmp_audio_buffer = self.tmp_audio_buffer[512:]

            with torch.inference_mode():
                speech_prob = self.vad_model(torch.from_numpy(chunk), self.SAMPLING_RATE).item()
            print(f"Speech probability: {speech_prob:.2f}")

            if speech_prob < self.SPEECH_THRESHOLD:
                if self.silent_samples <= self.SILENCE_WAIT_TIME:
                    self.silent_samples += 512
            else:
                self.silent_samples = 0
                if not self.started_speaking:
                    pre = self.sentence_audio_buffer[-int(self.PRE_SPEECH_SAMPLES):]
                    self.sentence_audio_buffer = list(pre)
                self.started_speaking = True

            if self.started_speaking:
                self.sentence_audio_buffer.extend(chunk)

            if self.started_speaking and self.silent_samples > self.SILENCE_WAIT_TIME:
                post = self.tmp_audio_buffer[:int(self.POST_SPEECH_SAMPLES)]
                self.sentence_audio_buffer.extend(post)

                transcribed_text = self.process_speech(np.array(self.sentence_audio_buffer))
                if transcribed_text:
                    print(f"Transcription: {transcribed_text}")

                self.vad_iterator.reset_states()
                self._reset_buffers()


if __name__ == "__main__":
    vi = VoiceInput()
    vi.run_cli()
