import { HistoryItem } from './types';
import { pipelineManager } from './pipelineManager';
import { cut5 } from './utils';
import { createNewSession, updateSession, fetchSessionContent } from './sessionManager';
import { cameraManager } from './cameraManager';

type ChatUpdateCallback = (messages: HistoryItem[]) => void;

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
    private subscribers: Map<ChatUpdateCallback, SubscriptionOptions> = new Map();

    private static readonly MAX_OCR_CHARS = 1600;
    private static readonly VISION_MODEL_HINTS = [
        'gemma4', 'gemma-4', 'llava', 'moondream', 'vision', 'minicpm-v', 'qwen2.5-vl', 'qwen3-vl'
    ];
    private static readonly SCREEN_QUERY_RE =
        /\b(screen|screenshot|display|monitor|desktop|window|tab|youtube|browser|ocr|text on|what('?s| is) on (my |the )?screen)\b|layar|screenshot|monitor/i;
    private static readonly CAMERA_QUERY_RE =
        /\b(camera|webcam|cam\b|see me|look at me|how do i look|what do i look|selfie|face|my appearance|do i look|from the camera|on (the |my )?camera)\b|kamera|melihat(ku| aku)|lihat(ku| aku)|wajah|penampilan|dari kamera/i;

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
        const frame = cameraManager.captureJpegBase64(1024, 0.85);
        if (frame) {
            this.currentCameraImage = frame;
        }
        return frame;
    }

    private collectImagesForRequest(userText: string): string[] {
        const images: string[] = [];
        const wantsCamera = this.isCameraQuery(userText);
        const wantsScreen = this.isScreenQuery(userText);
        const vagueSee =
            /\b(see|look|lihat|melihat)\b/i.test(userText) && !wantsScreen;

        if (wantsCamera || (vagueSee && cameraManager.isReady())) {
            const cam = this.refreshCameraFrame() || this.currentCameraImage.trim();
            if (cam) {
                images.push(cam.startsWith('data:') ? (cam.split(',', 2)[1] ?? cam) : cam);
            }
        }

        if (wantsScreen || (this.visionModelHint && !wantsCamera && this.currentImage.trim())) {
            const screen = this.currentImage.trim();
            if (screen) {
                images.push(screen.startsWith('data:') ? (screen.split(',', 2)[1] ?? screen) : screen);
            }
        }

        if (wantsCamera && images.length === 0) {
            const cam = this.refreshCameraFrame();
            if (cam) images.push(cam);
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

    public getFullSystemPrompt(): string {
        return this.fullSystemPrompt;
    }

    public setFullSystemPrompt(prompt: string) {
        this.fullSystemPrompt = prompt;
        this.notifySubscribers('onFullSystemPromptChange');
    }

    private buildSystemPrompt(memoryContext = "", userText = ""): string {
        const hasScreen = Boolean(this.visionPrompt.trim() || this.ocrPrompt.trim() || this.currentImage.trim());
        const cameraLive = cameraManager.isReady();
        const wantsCamera = this.isCameraQuery(userText);

        const cameraAwareness = cameraLive
            ? [
                "[LIVE CAMERA]",
                "You can currently see the user through their webcam.",
                "When a camera image is attached, describe what you see about the person naturally (appearance, expression, clothing, setting) as if looking at them.",
                "If they ask whether you can see them / see them from the camera, say yes and describe them warmly.",
                "Never say you cannot see them while the live camera is active.",
                "Do not mention technical camera capture details.",
                "",
              ].join("\n")
            : wantsCamera
            ? [
                "[CAMERA UNAVAILABLE]",
                "The user asked about the camera, but webcam share is not active. Gently ask them to enable \"Share camera with AI\" on the Input page.",
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
        const instructionsSection = `[INSTRUCTIONS]\n${this.systemPrompt}\n\n`;

        return cameraAwareness + screenAwareness + visionSection + ocrSection + contextSection + instructionsSection;
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

        this.abortController = new AbortController();
        const userMessage: HistoryItem = { role: 'user', content: input };
        const history = this.messages.slice(-30);
        
        this.messages.push(userMessage);
        this.notifySubscribers('onMessagesChange');

        try {
            // Fetch relevant context from memory (if enabled)
            let contextText = '';
            if (this.enableMemoryRetrieval) {
                try {
                    const contextRes = await fetch('/api/memory/context', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: input, limit: 3 })
                    });
                    if (contextRes.ok) {
                        const contextData = await contextRes.json();
                        if (Array.isArray(contextData.context) && contextData.context.length > 0) {
                            contextText = contextData.context
                                .map((c: Record<string, unknown>) => typeof c.document === 'string' ? c.document : '')
                                .filter(Boolean)
                                .join('\n');
                        }
                    }
                } catch (ctxErr) {
                    console.warn('Failed to fetch context:', ctxErr);
                }
            } else {
                // Clear retrieved context when memory retrieval is disabled
                this.setRetrievedContext('');
            }

            // Capture webcam frame before building prompt when camera share is live
            if (cameraManager.isReady() && (this.isCameraQuery(input) || this.visionModelHint)) {
                this.refreshCameraFrame();
            }

            // Assemble system prompt with labeled sections + live camera/screen awareness
            const systemPromptWithContext = this.buildSystemPrompt(contextText, input);

            // Set the retrieved context and full system prompt
            this.setRetrievedContext(contextText);
            this.setFullSystemPrompt(systemPromptWithContext);

            const payload: Record<string, unknown> = {
                text: input,
                history: history,
                systemPrompt: systemPromptWithContext,
            };
            const images = this.collectImagesForRequest(input);
            if (images.length > 0) {
                payload.images = images;
            }

            console.log("getCompletion", JSON.stringify({
                text: input,
                history: history,
                systemPrompt: systemPromptWithContext,
                hasImage: Array.isArray(payload.images),
                imageCount: images.length,
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

            this.messages = [...this.messages, { role: 'user', content: input }];
            this.notifySubscribers('onMessagesChange');

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
        let contextText = '';
        if (this.enableMemoryRetrieval) {
            try {
                const contextRes = await fetch('/api/memory/context', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: lastUserMessage.content, limit: 3 })
                });
                if (contextRes.ok) {
                    const contextData = await contextRes.json();
                    if (Array.isArray(contextData.context) && contextData.context.length > 0) {
                        contextText = contextData.context
                            .map((c: Record<string, unknown>) => typeof c.document === 'string' ? c.document : '')
                            .filter(Boolean)
                            .join('\n');
                    }
                }
            } catch (ctxErr) {
                console.warn('Failed to fetch context:', ctxErr);
            }
        }

        if (cameraManager.isReady() && (this.isCameraQuery(lastUserMessage.content) || this.visionModelHint)) {
            this.refreshCameraFrame();
        }

        // Assemble system prompt with context (same logic as sendMessage)
        const systemPromptWithContext = this.buildSystemPrompt(contextText, lastUserMessage.content);
        this.setRetrievedContext(contextText);
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