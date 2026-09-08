import { useEffect, useRef, useState } from "react";
import { FileText, RefreshCcw, Trash2, Upload } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader } from "./ui/card";
import {
  fetchDocuments,
  uploadDocument,
  deleteDocument,
  reindexDocument,
  ACCEPTED_DOCUMENT_TYPES,
  type KnowledgeDocument,
} from "@/lib/documentManager";
import { toast } from "sonner";

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function DocumentList() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = async () => {
    setLoading(true);
    try {
      setDocuments(await fetchDocuments());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDocuments();
  }, []);

  const filtered = documents.filter((doc) =>
    doc.filename.toLowerCase().includes(search.toLowerCase())
  );

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      try {
        await uploadDocument(file);
        toast.success(`Indexed ${file.name}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
      }
    }
    await loadDocuments();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDelete = async (doc: KnowledgeDocument) => {
    setBusyId(doc.id);
    try {
      const ok = await deleteDocument(doc.id);
      if (ok) {
        toast.success(`Deleted ${doc.filename}`);
        await loadDocuments();
      } else {
        toast.error("Delete failed");
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleReindex = async (doc: KnowledgeDocument) => {
    setBusyId(doc.id);
    try {
      const ok = await reindexDocument(doc.id);
      if (ok) {
        toast.success(`Reindexed ${doc.filename}`);
        await loadDocuments();
      } else {
        toast.error("Reindex failed");
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">Documents</h3>
          <p className="text-sm text-muted-foreground">
            Upload PDF, Markdown, text, or images. Content is indexed for AI retrieval in chat.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept={ACCEPTED_DOCUMENT_TYPES}
            onChange={(e) => void handleUpload(e.target.files)}
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
          <Button variant="ghost" onClick={() => void loadDocuments()} disabled={loading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <Input
        placeholder="Search documents..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {loading ? "Loading documents..." : "No documents yet. Upload a file to build your knowledge base."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map((doc) => (
            <Card key={doc.id} className="hover:bg-muted/20">
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="truncate font-medium">{doc.filename}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatBytes(doc.size)} · {doc.kind || "file"} · {formatDate(doc.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {doc.indexed ? (
                    <Badge variant="secondary">Indexed</Badge>
                  ) : (
                    <Badge variant="outline">Not indexed</Badge>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === doc.id}
                    onClick={() => void handleReindex(doc)}
                    title="Reindex"
                  >
                    <RefreshCcw className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={busyId === doc.id}
                    onClick={() => void handleDelete(doc)}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0 text-sm text-muted-foreground">
                {doc.error ? (
                  <span className="text-yellow-600 dark:text-yellow-400">{doc.error}</span>
                ) : (
                  <span>{doc.char_count.toLocaleString()} characters extracted</span>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
