import hashlib
import os
import random
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .TTS import TTS

FILLER_LIBRARY = {
    "neutral": ["Hmm...", "Well...", "Let me see..."],
    "thinking": ["Umm...", "Hmm, let me think...", "One moment..."],
    "happy": ["Hehe~", "Ah!", "Yay~"],
    "concerned": ["Oh...", "Hmm...", "Are you okay?"],
    "playful": ["Ehehe~", "Mmm?", "Oh my~"],
    "affectionate": ["Mm~", "Honey...", "Hmm~"],
}

VALID_MOODS = set(FILLER_LIBRARY.keys())


def detect_mood(text: str, user_text: str = "") -> str:
    combined = f"{text} {user_text}".lower()

    if any(w in combined for w in ["worried", "sad", "tired", "upset", "cry", "stressed", "hurt"]):
        return "concerned"
    if any(w in combined for w in ["hehe", "haha", "lol", "yay", "happy", "love", "great", "!"]):
        return "happy"
    if any(w in combined for w in ["honey", "dear", "kiss", "miss you", "sweetheart", "darling"]):
        return "affectionate"
    if any(w in combined for w in ["?", "how", "why", "what", "think", "wonder"]):
        return "thinking"
    if any(w in combined for w in ["ehe", "teehee", "naughty", "playful", "cute", "silly"]):
        return "playful"

    return "neutral"


def pick_filler_phrase(mood: str) -> str:
    if mood not in VALID_MOODS:
        mood = "neutral"
    return random.choice(FILLER_LIBRARY[mood])


def _cache_path(fillers_dir: str, voice: str, mood: str, phrase: str) -> str:
    phrase_hash = hashlib.md5(phrase.encode("utf-8")).hexdigest()[:10]
    voice_dir = os.path.join(fillers_dir, voice)
    os.makedirs(voice_dir, exist_ok=True)
    return os.path.join(voice_dir, f"{mood}_{phrase_hash}.wav")


def get_filler_audio(tts: "TTS", mood: str, context_text: str = "", user_text: str = "") -> bytes:
    if mood not in VALID_MOODS:
        mood = detect_mood(context_text, user_text)

    phrase = pick_filler_phrase(mood)
    voice = tts.current_voice or "leaf"
    fillers_dir = os.path.join(os.path.dirname(__file__), "fillers_cache")
    cache_file = _cache_path(fillers_dir, voice, mood, phrase)

    if os.path.exists(cache_file):
        with open(cache_file, "rb") as f:
            return f.read()

    audio = tts.synthesize(phrase)
    if isinstance(audio, dict):
        raise RuntimeError(audio.get("Exception", "Filler synthesis failed"))

    with open(cache_file, "wb") as f:
        f.write(audio)
    return audio


def warm_up_fillers(tts: "TTS", moods: list[str] | None = None) -> None:
    moods = moods or list(VALID_MOODS)
    for mood in moods:
        try:
            get_filler_audio(tts, mood)
        except Exception:
            pass
