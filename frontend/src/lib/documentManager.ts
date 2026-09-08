export interface KnowledgeDocument {
  id: string;
  filename: string;
  mime: string;
  size: number;
  created_at?: string;
  indexed: boolean;
  indexed_at?: string | null;
  char_count: number;
  kind: string;
  error?: string | null;
}

export interface UploadDocumentResult {
  document: KnowledgeDocument;
  preview?: string;
}

export async function fetchDocuments(): Promise<KnowledgeDocument[]> {
  const res = await fetch("/api/documents");
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.documents) ? data.documents : [];
}

export async function uploadDocument(file: File): Promise<UploadDocumentResult | null> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/documents/upload", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Upload failed");
  }
  return data as UploadDocumentResult;
}

export async function deleteDocument(docId: string): Promise<boolean> {
  const res = await fetch(`/api/documents/${docId}`, { method: "DELETE" });
  return res.ok;
}

export async function reindexDocument(docId: string): Promise<boolean> {
  const res = await fetch(`/api/documents/${docId}/reindex`, { method: "POST" });
  return res.ok;
}

export async function fetchDocumentPreview(docId: string): Promise<string> {
  const res = await fetch(`/api/documents/${docId}`);
  if (!res.ok) return "";
  const data = await res.json();
  return typeof data.preview === "string" ? data.preview : "";
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",", 2)[1] ?? result : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name);
}

export const ACCEPTED_DOCUMENT_TYPES =
  ".pdf,.txt,.md,.markdown,.jpg,.jpeg,.png,.webp,application/pdf,text/plain,text/markdown,image/jpeg,image/png,image/webp";
