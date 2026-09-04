import { useEffect, useMemo, useState } from "react";
import { chatManager } from "@/lib/chatManager";
import { pipelineManager } from "@/lib/pipelineManager";
import type { HistoryItem } from "@/lib/types";
import type { Task } from "@/constants/types";
import ChatMarkdown from "@/components/chat-markdown";
import { cn } from "@/lib/utils";

const IDLE_HIDE_MS = 20000;

function getLiveCaption(tasks: Task[], messages: HistoryItem[]): string {
  // Prefer the sentence currently being spoken (or next in TTS queue)
  for (const task of tasks) {
    if (task.status === "cancelled" || task.status === "task_finished") continue;
    for (const res of task.response) {
      const text = res.text?.trim();
      if (!text || res.tts_failed) continue;
      if (res.audio && !res.playback_finished) return text;
    }
    for (const res of task.response) {
      const text = res.text?.trim();
      if (!text || res.tts_failed || res.audio) continue;
      return text;
    }
  }

  // Fall back to the latest assistant chat message (streaming on Home)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.trim()) {
      return messages[i].content.trim();
    }
  }
  return "";
}

export function CharacterCaption({ visible = true }: { visible?: boolean }) {
  const [messages, setMessages] = useState<HistoryItem[]>(() => chatManager.getMessages());
  const [tasks, setTasks] = useState<Task[]>(() => pipelineManager.getTasks());
  const [hiddenByIdle, setHiddenByIdle] = useState(false);

  useEffect(() => {
    const unsubChat = chatManager.subscribe((next) => {
      setMessages(next);
    });
    const unsubPipe = pipelineManager.subscribe((next) => {
      setTasks(next);
    });
    return () => {
      unsubChat();
      unsubPipe();
    };
  }, []);

  const caption = useMemo(() => getLiveCaption(tasks, messages), [tasks, messages]);

  useEffect(() => {
    if (!caption) {
      setHiddenByIdle(true);
      return;
    }
    setHiddenByIdle(false);
    const timer = window.setTimeout(() => setHiddenByIdle(true), IDLE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [caption]);

  const show = visible && Boolean(caption) && !hiddenByIdle;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-24 z-40 flex justify-center px-4 transition-opacity duration-300 sm:bottom-28",
        show ? "opacity-100" : "opacity-0"
      )}
      aria-live="polite"
      aria-hidden={!show}
    >
      <div className="max-h-[40vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-white/15 bg-black/70 px-5 py-3 text-center shadow-lg backdrop-blur-md">
        <div className="text-sm leading-relaxed text-white sm:text-base [&_a]:text-sky-300 [&_blockquote]:border-white/40 [&_blockquote]:text-white/80 [&_code]:bg-white/10 [&_p]:text-white">
          <ChatMarkdown content={caption} className="text-left sm:text-center" />
        </div>
      </div>
    </div>
  );
}
