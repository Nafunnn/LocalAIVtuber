import { HistoryItem } from './types';
import { pipelineManager } from './pipelineManager';
import { cut5 } from './utils';
import { createNewSession, updateSession, fetchSessionContent } from './sessionManager';
import { cameraManager } from './cameraManager';
import type { KnowledgeDocument } from './documentManager';

type ChatUpdateCallback = (messages: HistoryItem[]) => void;

function isProactiveCheckInPrompt(text: string): boolean {
    return /\[Proactive daily check-in/i.test(text);
}

export interface PendingDocumentAttachment {
    id: string;
    filename: string;
    mime: string;
    kind: string;
    imageBase64?: string;
}

interface SubscriptionOptions {
    onMessagesChange?: boolean;
    onSystemPromptChange?: boolean;
    onVisionPromptChange?: boolean;
    onOcrPromptChange?: boolean;
    onImageChange?: boolean;
    onContextChange?: boolean;
    onFullSystemPromptChange?: boolean;
}

export class ChatManager {
    private messages: HistoryItem[] = [];
    private sessionId: string | null = null;
    private abortController: AbortController | null = null;
    private systemPrompt: string = '';
    private visionPrompt: string = '';
    private ocrPrompt: string = '';
    private currentImage: string = '';
    private currentImageMime: string = 'image/jpeg';
    private currentCameraImage: string = '';
    private visionModelHint: boolean = false;
    private retrievedContext: string = '';
    private fullSystemPrompt: string = '';
    private enableMemoryRetrieval: boolean = true;
    private pendingDocuments: PendingDocumentAttachment[] = [];
    private subscribers: Map<ChatUpdateCallback, SubscriptionOptions> = new Map();

    private static readonly MAX_OCR_CHARS = 1600;
    private static readonly VISION_MODEL_HINTS = [
        'gemma4', 'gemma-4', 'llava', 'moondream', 'vision', 'minicpm-v', 'qwen2.5-vl', 'qwen3-vl'
    ];
    private static readonly SCREEN_QUERY_RE =
        /\b(screen|screenshot|display|monitor|desktop|window|tab|youtube|browser|ocr|text on|what('?s| is) on (my |the )?screen)\b|layar|screenshot|monitor/i;
    private static readonly CAMERA_QUERY_RE =
        /\b(camera|webcam|cam\b|see me|look at me|how do i look|what do i look|selfie|face|my appearance|do i look|from the camera|on (the |my )?camera|take (a )?(photo|picture|pic|snapshot)|capture|snap (a )?(photo|pic)?|photo of me|picture of me)\b|kamera|melihat(ku| aku)|lihat(ku| aku)|wajah|penampilan|dari kamera|ambil (foto|gambar|potret)|foto(in| kan)?( aku| saya)?|potret|jepret/i;

    constructor() {
        this.setupPipelineSubscription();
    }

    public subscribe(callback: ChatUpdateCallback, options: SubscriptionOptions = { onMessagesChange: true }): () => void {
        this.subscribers.set(callback, options);
        return () => this.subscribers.delete(callback);
    }

    private notifySubscribers(changeType: keyof SubscriptionOptions) {
        this.subscribers.forEach((options, callback) => {
            if (options[changeType]) {
                callback([...this.messages]);
            }
        });
    }

    public getSystemPrompt(): string {
        return this.systemPrompt;
    }

    public setSystemPrompt(systemPrompt: string) {
        this.systemPrompt = systemPrompt;
        this.notifySubscribers('onSystemPromptChange');
    }

    public getVisionPrompt(): string {
        return this.visionPrompt;
    }

    public setVisionPrompt(visionPrompt: string) {
        this.visionPrompt = visionPrompt;
        this.notifySubscribers('onVisionPromptChange');
    }

    public getOcrPrompt(): string {
        return this.ocrPrompt;
    }

    public setOcrPrompt(ocrPrompt: string) {
        const trimmed = ocrPrompt.trim();
        this.ocrPrompt = trimmed.length > ChatManager.MAX_OCR_CHARS
            ? `${trimmed.slice(0, ChatManager.MAX_OCR_CHARS - 20).trimEnd()}\n…[truncated]`
            : trimmed;
        this.notifySubscribers('onOcrPromptChange');
    }

    public getCurrentImage(): string {
        return this.currentImage;
    }

    public getCurrentImageMime(): string {
        return this.currentImageMime;
    }

    public setCurrentImage(image: string, mime = 'image/jpeg') {
        this.currentImage = image;
        this.currentImageMime = mime || 'image/jpeg';
        this.notifySubscribers('onImageChange');
    }

    public setCurrentCameraImage(image: string) {
        this.currentCameraImage = image;
    }

    public getCurrentCameraImage(): string {
        return this.currentCameraImage;
    }

    public setVisionModelHint(enabled: boolean) {
        this.visionModelHint = enabled;
    }

    public static modelLooksMultimodal(modelId?: string | null): boolean {
        if (!modelId) return false;
        const id = modelId.toLowerCase();
        return ChatManager.VISION_MODEL_HINTS.some((hint) => id.includes(hint));
    }

    private isCameraQuery(userText: string): boolean {
        return ChatManager.CAMERA_QUERY_RE.test(userText);
    }

    private isScreenQuery(userText: string): boolean {
        return ChatManager.SCREEN_QUERY_RE.test(userText);
    }

    private refreshCameraFrame(): string | null {
        if (!cameraManager.isReady()) return null;
        const frame = cameraManager.captureJpegBase64(1280, 0.88);
        if (frame) {
            this.currentCameraImage = frame;
        }
        return frame;
    }

    private toDisplayDataUrl(base64OrDataUrl: string): string {
        const raw = base64OrDataUrl.trim();
        if (raw.startsWith("data:")) return raw;
        return `data:image/jpeg;base64,${raw}`;
    }

    private toRawBase64(base64OrDataUrl: string): string {
        const raw = base64OrDataUrl.trim();
        if (raw.startsWith("data:")) return raw.split(",", 2)[1] ?? raw;
        return raw;
    }

    /**
     * Capture a fresh webcam frame now (for Input "Capture" button / next chat turn).
     * Returns a display data URL, or null if camera share is off.
     */
    public captureCameraSnapshot(): string | null {
        const frame = this.refreshCameraFrame();
        return frame ? this.toDisplayDataUrl(frame) : null;
    }

    /**
     * Capture the shared camera and ask the vision model to describe it.
     */
    public async sendCameraSnapshot(
        prompt = "Please look at this camera photo of me and describe what you see warmly and specifically.",
    ): Promise<boolean> {
        const frame = this.refreshCameraFrame();
        if (!frame) return false;
        await this.sendMessage(prompt);
        return true;
    }

    private shouldAttachCamera(userText: string): boolean {
        if (!cameraManager.isReady()) return false;
        if (this.isCameraQuery(userText)) return true;
        const vagueSee =
            /\b(see|look|lihat|melihat|foto|photo|picture|gambar)\b/i.test(userText) &&
            !this.isScreenQuery(userText);
        if (vagueSee) return true;
        // Vision models with live camera: attach when user talks about appearance / themselves visually
        if (this.visionModelHint && /\b(me|aku|saya|i('?m| am)|outfit|wearing|hair|shirt)\b/i.test(userText)) {
            return true;
        }
        return false;
    }

    private collectImagesForRequest(userText: string): string[] {
        const images: string[] = [];
        const wantsCamera = this.shouldAttachCamera(userText);
        const wantsScreen = this.isScreenQuery(userText);

        if (wantsCamera) {
            const cam = this.refreshCameraFrame() || this.currentCameraImage.trim();
            if (cam) images.push(this.toRawBase64(cam));
        }

        if (wantsScreen || (this.visionModelHint && !wantsCamera && this.currentImage.trim())) {
            const screen = this.currentImage.trim();
            if (screen) images.push(this.toRawBase64(screen));
        }

        for (const attachment of this.pendingDocuments) {
            if (attachment.imageBase64) {
                images.push(attachment.imageBase64);
            }
        }

        return images;
    }

    public getRetrievedContext(): string {
        return this.retrievedContext;
    }

    public setRetrievedContext(context: string) {
        this.retrievedContext = context;
        this.notifySubscribers('onContextChange');
    }

    public setEnableMemoryRetrieval(enabled: boolean) {
        this.enableMemoryRetrieval = enabled;
        // Clear retrieved context immediately when memory retrieval is disabled
        if (!enabled) {
            this.setRetrievedContext('');
        }
    }

    public getPendingDocuments(): PendingDocumentAttachment[] {
        return [...this.pendingDocuments];
    }

    public addPendingDocument(doc: KnowledgeDocument, imageBase64?: string) {
        this.pendingDocuments = [
            ...this.pendingDocuments.filter((d) => d.id !== doc.id),
            {
                id: doc.id,
                filename: doc.filename,
                mime: doc.mime,
                kind: doc.kind,
                imageBase64,
            },
        ];
    }

    public removePendingDocument(docId: string) {
        this.pendingDocuments = this.pendingDocuments.filter((d) => d.id !== docId);
    }

    public clearPendingDocuments() {
        this.pendingDocuments = [];
    }

    private formatContextChunks(items: unknown[]): string {
        return items
            .map((item) => {
                if (!item || typeof item !== 'object') return '';
                const row = item as Record<string, unknown>;
                const doc = typeof row.document === 'string' ? row.document : '';
                if (!doc) return '';
                const filename = typeof row.filename === 'string' ? row.filename : '';
                return filename ? `[${filename}]\n${doc}` : doc;
            })
            .filter(Boolean)
            .join('\n\n');
    }

    private async fetchRetrievalContext(input: string): Promise<{ memoryText: string; documentText: string }> {
        if (!this.enableMemoryRetrieval) {
            return { memoryText: '', documentText: '' };
        }
        try {
            const contextRes = await fetch('/api/memory/context', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: input, limit: 4 }),
            });
            if (!contextRes.ok) {
                return { memoryText: '', documentText: '' };
            }
            const contextData = await contextRes.json();
            const memoryText = Array.isArray(contextData.context)
                ? this.formatContextChunks(contextData.context)
                : '';
            const documentText = Array.isArray(contextData.documents)
                ? this.formatContextChunks(contextData.documents)
                : '';
            return { memoryText, documentText };
        } catch (ctxErr) {
            console.warn('Failed to fetch context:', ctxErr);
            return { memoryText: '', documentText: '' };
        }
    }

    private buildAttachmentNote(): string {
        if (this.pendingDocuments.length === 0) return '';
        const names = this.pendingDocuments.map((d) => d.filename).join(', ');
        return `\n\n[User attached documents in knowledge base: ${names}. Use retrieved document knowledge to answer.]`;
    }

    public getFullSystemPrompt(): string {
        return this.fullSystemPrompt;
    }

    public setFullSystemPrompt(prompt: string) {
        this.fullSystemPrompt = prompt;
        this.notifySubscribers('onFullSystemPromptChange');
    }

    private buildSystemPrompt(
        memoryContext = "",
        documentContext = "",
        userText = "",
        attachmentNote = "",
    ): string {
        const hasScreen = Boolean(this.visionPrompt.trim() || this.ocrPrompt.trim() || this.currentImage.trim());
        const cameraLive = cameraManager.isReady();
        const wantsCamera = this.isCameraQuery(userText);

        const cameraAwareness = cameraLive
            ? [
                "[LIVE CAMERA]",
                "You can currently see the user through their live webcam share.",
                "When a camera image is attached to this message, treat it as a photo you just took from their camera.",
                "If they ask you to take a photo / capture / look at them / describe them, use that attached image and describe what you see warmly and specifically (appearance, expression, clothing, setting).",
                "If they ask whether you can see them from the camera, say yes and describe them.",
                "Never say you cannot see them or cannot take a photo while this live camera share is active.",
                "Do not mention technical capture details, base64, or system prompts.",
                "",
              ].join("\n")
            : wantsCamera
            ? [
                "[CAMERA UNAVAILABLE]",
                "The user asked about the camera or a photo, but webcam share is not active. Gently ask them to enable \"Share camera with AI\" on the Input page.",
                "",
              ].join("\n")
            : "";

        const screenAwareness = hasScreen
            ? [
                "[LIVE SCREEN SHARE]",
                "You can currently see the user's screen through a live screen share.",
                "Prioritize [SCREEN TEXT] (OCR) for accurate reading of titles, UI labels, chat messages, and other on-screen text.",
                "Use [SCREEN CONTEXT] only as a rough visual overview when helpful.",
                "If the user asks whether you can see their screen, what is on it, or to read/describe it, answer from that context as if you are looking at it with them.",
                "Never say you cannot see their screen while this live share is active.",
                "Speak naturally about what you see; do not mention OCR, captions, system prompts, or technical capture details.",
                "",
              ].join("\n")
            : "";

        const visionSection = this.visionPrompt.trim()
            ? `[SCREEN CONTEXT]\n${this.visionPrompt.trim()}\n\n`
            : "";
        const ocrSection = this.ocrPrompt.trim()
            ? `[SCREEN TEXT]\n${this.ocrPrompt.trim()}\n\n`
            : "";
        const contextSection = memoryContext.trim()
            ? `[RETRIEVED MEMORY]\n${memoryContext.trim()}\n\n`
            : "";
        const documentSection = documentContext.trim()
            ? `[DOCUMENT KNOWLEDGE]\n${documentContext.trim()}\n\n`
            : "";
        const attachmentSection = attachmentNote.trim()
            ? `[ATTACHED FILES]\n${attachmentNote.trim()}\n\n`
            : "";
        const instructionsSection = `[INSTRUCTIONS]\n${this.systemPrompt}\n\n`;

        return (
            cameraAwareness +
            screenAwareness +
            visionSection +
            ocrSection +
            contextSection +
            documentSection +
            attachmentSection +
            instructionsSection
        );
    }

    private setupPipelineSubscription() {
        const handlePipelineUpdate = () => {
            this.handleInterrupt();
            const task = pipelineManager.getNextTaskForLLM();
            if (!task) return;
            const input = task.input!;
            this.sendMessage(input, task.id);
        };

        return pipelineManager.subscribe(handlePipelineUpdate);
    }

    public handleInterrupt() {
        const currentTask = pipelineManager.getCurrentTask();
        if (currentTask?.status === "pending_interruption" && !currentTask.interruptionState?.llm) {
            if (this.abortController) {
                this.abortController.abort();
            }
            pipelineManager.markInterruptionState("llm");
            return true;
        }
        return false;
    }

    public async sendMessage(
        input: string, 
        taskId: string | null = null,
    ): Promise<void> {
        if (input.trim() === '') return;
        if (!taskId) taskId = null;
        else pipelineManager.markLLMStarted(taskId);

        const hideFromChat =
            (taskId !== null &&
                pipelineManager.getTaskById(taskId)?.hideFromChat === true) ||
            isProactiveCheckInPrompt(input);

        this.abortController = new AbortController();
        const attachmentNote = this.buildAttachmentNote();
        const messageText = `${input.trim()}${attachmentNote}`;

        // Capture shared-camera frame early when this turn needs it
        if (this.shouldAttachCamera(input)) {
            this.refreshCameraFrame();
        }
        const requestImages = this.collectImagesForRequest(input);
        const displayImages =
            this.shouldAttachCamera(input) && this.currentCameraImage.trim()
                ? [this.toDisplayDataUrl(this.currentCameraImage)]
                : undefined;

        const userMessage: HistoryItem = {
            role: 'user',
            content: messageText,
            images: displayImages,
        };
        const history = this.messages.slice(-30);
        
        if (!hideFromChat) {
            this.messages.push(userMessage);
            this.notifySubscribers('onMessagesChange');
        }

        try {
            const { memoryText, documentText } = await this.fetchRetrievalContext(input);
            const combinedContext = [memoryText, documentText].filter(Boolean).join('\n\n');

            // Assemble system prompt with labeled sections + live camera/screen awareness
            const systemPromptWithContext = this.buildSystemPrompt(
                memoryText,
                documentText,
                input,
                attachmentNote,
            );

            // Set the retrieved context and full system prompt
            this.setRetrievedContext(combinedContext);
            this.setFullSystemPrompt(systemPromptWithContext);

            const payload: Record<string, unknown> = {
                text: messageText,
                history: history,
                systemPrompt: systemPromptWithContext,
            };
            if (requestImages.length > 0) {
                payload.images = requestImages;
            }

            console.log("getCompletion", JSON.stringify({
                text: messageText,
                history: history,
                systemPrompt: systemPromptWithContext,
                hasImage: Array.isArray(payload.images),
                imageCount: requestImages.length,
                attachments: this.pendingDocuments.map((d) => d.filename),
                hideFromChat,
                cameraAttached: Boolean(displayImages?.length),
            }));
            const response = await fetch('/api/completion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error("Error during completion:", errorData?.error);
                return;
            }

            if (this.sessionId === null) {
                const newSessionId = await createNewSession();
                if (newSessionId) {
                    this.sessionId = newSessionId;
                }
            }

            await updateSession(this.sessionId, this.messages);

            // Visible chats keep a user bubble then replace it with the assistant stream.
            // Hidden prompts (daily check-ins) only show the assistant reply.
            this.messages = [
                ...this.messages,
                hideFromChat
                    ? { role: 'assistant', content: '' }
                    : { role: 'user', content: messageText, images: displayImages },
            ];
            this.notifySubscribers('onMessagesChange');
            this.clearPendingDocuments();
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let aiMessage = '';
            let currentText = '';
            
            if (!reader) return;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value);
                aiMessage += chunk;
                
                this.messages = [...this.messages.slice(0, -1), { role: 'assistant', content: aiMessage }];
                this.notifySubscribers('onMessagesChange');

                currentText += chunk;
                const { sentences, remaining } = cut5(currentText);
                
                if (sentences.length > 0) {
                    for (const sentence of sentences) {
                        const trimmed = sentence.trim();
                        if (trimmed.length > 0) {
                            if (taskId === null) {
                                taskId = pipelineManager.createTaskFromLLM(input, trimmed);
                            } else {
                                pipelineManager.addLLMResponse(taskId, trimmed);
                            }
                        }
                    }
                    currentText = remaining;
                }
            }

            if (currentText.length > 0) {
                if (taskId === null) {
                    taskId = pipelineManager.createTaskFromLLM(input, currentText);
                } else {
                    pipelineManager.addLLMResponse(taskId, currentText);
                }
            }

            if (taskId !== null) {
                pipelineManager.markLLMFinished(taskId);
            }
            
            await updateSession(this.sessionId, this.messages);
            this.notifySubscribers('onMessagesChange');

        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                console.log('Fetch aborted');
            } else {
                console.error('Fetch error:', error);
            }
        }
    }

    public async continueMessage(index: number) {
        // take history from beginning of history to index
        const history = this.messages.slice(0, index + 1);
        // send history to backend
        const response = await fetch('/api/completion/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: history, systemPrompt: this.systemPrompt })
        });
        // get streaming response similar to sendMessage
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) return;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            // add to the existing message
            this.messages[index].content += chunk;
            this.notifySubscribers('onMessagesChange');
        }
        await updateSession(this.sessionId, this.messages);
        this.notifySubscribers('onMessagesChange');
    }

    public async regenerateMessage(index: number) {
        // Only regenerate assistant messages
        if (this.messages[index].role !== 'assistant') return;
        
        // take history from beginning up to (but not including) the message being regenerated
        const historyUpToMessage = this.messages.slice(0, index);
        
        // Get the user message that prompted this assistant response
        const lastUserMessage = historyUpToMessage[historyUpToMessage.length - 1];
        if (!lastUserMessage || lastUserMessage.role !== 'user') return;

        // Clear the current assistant message content
        this.messages[index].content = '';
        this.notifySubscribers('onMessagesChange');

        // Use the same context logic as sendMessage for consistency
        const { memoryText, documentText } = await this.fetchRetrievalContext(lastUserMessage.content);
        const combinedContext = [memoryText, documentText].filter(Boolean).join('\n\n');

        if (this.shouldAttachCamera(lastUserMessage.content)) {
            this.refreshCameraFrame();
        }

        // Assemble system prompt with context (same logic as sendMessage)
        const systemPromptWithContext = this.buildSystemPrompt(
            memoryText,
            documentText,
            lastUserMessage.content,
        );
        this.setRetrievedContext(combinedContext);
        this.setFullSystemPrompt(systemPromptWithContext);

        const payload: Record<string, unknown> = {
            text: lastUserMessage.content,
            history: historyUpToMessage.slice(0, -1),
            systemPrompt: systemPromptWithContext,
        };
        const images = this.collectImagesForRequest(lastUserMessage.content);
        if (images.length > 0) {
            payload.images = images;
        }

        // Send completion request with history up to the user message
        const response = await fetch('/api/completion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error("Error during regeneration");
            return;
        }

        // Stream the new response
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) return;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            this.messages[index].content += chunk;
            this.notifySubscribers('onMessagesChange');
        }
        
        await updateSession(this.sessionId, this.messages);
        this.notifySubscribers('onMessagesChange');
    }

    public getMessages(): HistoryItem[] {
        return this.messages;
    }

    public setMessages(messages: HistoryItem[]) {
        this.messages = messages;
        this.notifySubscribers('onMessagesChange');
    }

    public getSessionId(): string | null {
        return this.sessionId;
    }

    public async setSessionId(id: string | null) {
        this.sessionId = id;
        // update session chat history
        if (id) {
            const session = await fetchSessionContent(id);
            this.messages = session.history;
        }
        this.notifySubscribers('onMessagesChange');
    }
}

export const chatManager = new ChatManager(); 