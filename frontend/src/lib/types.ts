export type HistoryItem = {
    role: "assistant" | "user";
    content: string;
    /** Optional display-only image data URLs (e.g. camera snapshots). */
    images?: string[];
}

export interface Session {
    id: string
    title: string
    created_at: string
    history?: HistoryItem[]
    message_count?: number
    indexed?: boolean
    indexed_at?: string
  }