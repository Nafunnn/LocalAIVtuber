export type FillerMood =
  | "neutral"
  | "thinking"
  | "happy"
  | "concerned"
  | "playful"
  | "affectionate";

export function detectFillerMood(text: string, userText = ""): FillerMood {
  const combined = `${text} ${userText}`.toLowerCase();

  if (/worried|sad|tired|upset|cry|stressed|hurt/.test(combined)) {
    return "concerned";
  }
  if (/hehe|haha|lol|yay|happy|love|great|!/.test(combined)) {
    return "happy";
  }
  if (/honey|dear|kiss|miss you|sweetheart|darling/.test(combined)) {
    return "affectionate";
  }
  if (/\?|how|why|what|think|wonder/.test(combined)) {
    return "thinking";
  }
  if (/ehe|teehee|naughty|playful|cute|silly/.test(combined)) {
    return "playful";
  }

  return "neutral";
}

export async function fetchFillerAudio(
  mood: FillerMood,
  contextText = "",
  userText = ""
): Promise<string | null> {
  const params = new URLSearchParams({ mood });
  if (contextText) params.set("context", contextText.slice(0, 200));
  if (userText) params.set("user", userText.slice(0, 200));

  const response = await fetch(`/api/tts/filler?${params.toString()}`);
  if (!response.ok) return null;

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
