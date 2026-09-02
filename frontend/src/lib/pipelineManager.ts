
import { Task } from "../constants/types"
import { v4 as uuidv4 } from "uuid";

type PipelineListener = (tasks: Task[]) => void;

class PipelineManager {
  private tasks: Task[] = [];
  private listeners: Set<PipelineListener> = new Set();

  subscribe(listener: PipelineListener) {
    this.listeners.add(listener);
    listener(this.tasks);
    return () => { this.listeners.delete(listener) };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener([...this.tasks]);
    }
  }

  getTasks() {
    return [...this.tasks];
  }

  getTaskById(id: string) {
    return this.tasks.find(t => t.id === id);
  }

  addInputTask(input: string): string {
    const id = uuidv4();
    const task: Task = {
      id,
      input,
      response: [],
      status: "created"
    };
    this.tasks.push(task);
    this.notify();
    return id;
  }

  async waitForTaskCompletion(taskId: string): Promise<string> {
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe((tasks) => {
        const task = tasks.find(t => t.id === taskId);
        if (task?.status === "task_finished") {
          unsubscribe();
          resolve(task.response.map(r => r.text).join("\n"));
        } else if (task?.status === "cancelled") {
          unsubscribe();
          resolve("");
        }
      });
    });
  }

  createTaskFromLLM(input: string, initialResponse: string): string {
    const id = uuidv4();
    const task: Task = {
      id,
      input: input,
      response: [{ text: initialResponse }],
      status: "llm_started"
    };
    this.tasks.push(task);
    this.notify();
    return id;
  }

  addLLMResponse(taskId: string, text: string) {
    const task = this.getTaskById(taskId);
    if (!task || task.status == "cancelled") return;
    task.response.push({ text });
    this.notify();
  }

  markLLMStarted(taskId: string) {
    const task = this.getTaskById(taskId);
    if (task) {
      task.status = "llm_started";
      this.updateTaskStatus(task);
      this.notify();
    }
  }

  markLLMFinished(taskId: string) {
    const task = this.getTaskById(taskId);
    if (task) {
      task.status = "llm_finished";
      this.updateTaskStatus(task);
      this.notify();
    }
  }

  addTTSAudio(taskId: string, responseIndex: number, audioUrl: string) {
    const task = this.getTaskById(taskId);
    const response = task?.response?.[responseIndex];
    if (!task || !response || task.status == "cancelled") return;

    response.audio = audioUrl;
    this.updateTaskStatus(task);
    this.notify();
  }

  markPlaybackFinished(taskId: string, responseIndex: number) {
    const task = this.getTaskById(taskId);
    const response = task?.response?.[responseIndex];
    if (!task || !response) return;
    response.playback_finished = true;
    this.updateTaskStatus(task);
    this.notify();
  }

  markTTSFailed(taskId: string, responseIndex: number) {
    const task = this.getTaskById(taskId);
    const response = task?.response?.[responseIndex];
    if (!task || !response) return;
    response.tts_failed = true;
    response.playback_finished = true;
    this.updateTaskStatus(task);
    this.notify();
  }

  private getActiveTasks() {
    return this.tasks.filter(
      task => task.status !== "task_finished" && task.status !== "cancelled"
    );
  }

  private getSpeakableResponses(task: Task) {
    return task.response.filter(res => res.text?.trim());
  }

  getNextTaskForLLM() {
    const task = this.getCurrentTask()
    if (task && task.status !== "pending_interruption") {
      if (task.input && (task.status == "created")){
        return task;
      }
    }
    return undefined;
  }

  getNextTaskForTTS() {
    for (const task of this.getActiveTasks()) {
      if (task.status === "pending_interruption") continue;
      for (let j = 0; j < task.response.length; j++) {
        const res = task.response[j];
        if (res.text?.trim() && !res.audio && !res.tts_failed) {
          return {
            taskId: task.id,
            responseIndex: j,
            task,
          };
        }
      }
    }
    return undefined;
  }

  getNextTaskForAudio() {
    for (const task of this.getActiveTasks()) {
      if (task.status === "pending_interruption") continue;
      for (let j = 0; j < task.response.length; j++) {
        const res = task.response[j];
        if (res.text?.trim() && res.audio && !res.playback_finished && !res.tts_failed) {
          return {
            taskId: task.id,
            responseIndex: j,
            task,
          };
        }
      }
    }
    return undefined;
  }

  private updateTaskStatus(task: Task) {
    if (task.status == "cancelled") return
    if (
      task &&
      task.status === "pending_interruption" &&
      task.interruptionState &&
      task.interruptionState.tts &&
      task.interruptionState.llm &&
      task.interruptionState.audio
    ) {
      task.status = "cancelled";
    }

    const llmFinish = task.status == "llm_finished";
    const ttsFinish = task.status == "tts_finished";
    const speakable = this.getSpeakableResponses(task);
    const allAudio = speakable.length === 0 || speakable.every(r => r.audio || r.tts_failed);
    const allPlayback = speakable.length === 0 || speakable.every(r => r.playback_finished || r.tts_failed);
    if (llmFinish && allAudio) {
      task.status = "tts_finished";
    }
    if (ttsFinish && allPlayback) {
      task.status = "task_finished";
    }
  }

  // cancelPipeline() {
  //   const currentTask = this.getCurrentTask()
  //   if (currentTask && currentTask.status != "cancelled"){
  //     currentTask.status = "cancelled"
  //   }
  //   this.notify();
  // }

  interruptCurrentTask() {
    const task = this.getCurrentTask();
    if (task) {
      console.log("interrupting")
      task.status = "pending_interruption";
      task.interruptionState = { tts: false, llm: false, audio: false };
      this.notify();
    }
  }

  markInterruptionState(type: "llm" | "tts" | "audio") {
    const task = this.getCurrentTask();
    if (
      task &&
      task.status === "pending_interruption" &&
      task.interruptionState
    ) {
      if (type == "llm") task.interruptionState.llm = true;
      if (type == "tts") task.interruptionState.tts = true;
      if (type == "audio") task.interruptionState.audio = true;
      this.updateTaskStatus(task)
      this.notify();
    }
  }

  removeFinishedTasks(maxCount: number = 20) {
    const active = this.tasks.filter(t => !(t.status == "task_finished"));
    const recentFinished = this.tasks
      .filter(t => t.status == "task_finished")
      .slice(-maxCount);
    this.tasks = [...recentFinished, ...active];
    this.notify();
  }

  getCurrentTask(): Task | undefined {
    // Find the first task that is not finished or cancelled
    return this.tasks.find(task => task.status !== "task_finished" && task.status !== "cancelled");
  }

  reset() {
    this.tasks = [];
    this.notify();
  }
}

export const pipelineManager = new PipelineManager();