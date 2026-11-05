// One chat state, one run. The renderer mirrors this; it does not decide it.
import { randomUUID } from "node:crypto";
import type { Answers, ChatStateName, FlowEvent, Message, PendingQuestion, Settings, Theme } from "../shared/ipc.js";
import {
  QUESTION_BUSY,
  QUESTION_CANCELLED,
  QuestionRejected,
  answerJson,
  checkAnswers,
  skipJson,
  type AskRequest,
  type Question,
} from "../shared/questions.js";
import { AgentCallError, Cancelled, type AgentService, type AgentStreamEvent } from "./agent-service.js";
import { buildPrompt, selectSeed } from "./prompt.js";
import type { RulesSkills } from "./rules-skills-service.js";
import type { SettingsStore } from "./settings-store.js";

export class SessionError extends Error {
  readonly code: "not_ready" | "conflict" | "auth" | "agent_error" | "io_error" | "not_found" | "invalid_input";
  readonly retryable: boolean;

  constructor(code: SessionError["code"], message: string, retryable: boolean) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.retryable = retryable;
  }
}

type Pending = {
  questionId: string;
  title?: string;
  questions: Question[];
  /** SDK tool call id, kept with the question for logs. */
  toolCallId?: string;
  resolve: (result: string) => void;
  reject: (error: QuestionRejected) => void;
};

type RunRecord = {
  id: string;
  agentMessageId: string;
  generation: number;
  settled: boolean;
  abandoned: boolean;
  text: string;
};

export type ChatSession = {
  view(): Settings;
  save(partial: { folder?: string; model?: string; theme?: Theme }): Promise<Settings>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  listModels(): Promise<{ id: string; label: string }[]>;
  reset(): Promise<void>;
  send(text: string): Promise<{ runId: string; userMessageId: string; agentMessageId: string; restored: boolean }>;
  stop(): Promise<void>;
  ask(request: AskRequest): Promise<string>;
  answer(questionId: string, answers: Answers): void;
  skip(questionId: string): void;
  history(): { messages: Message[] };
  state(): { state: ChatStateName; runId?: string; instructionsPending: boolean; pendingQuestion?: PendingQuestion };
  shutdown(): Promise<void>;
  isShuttingDown(): boolean;
};

export function createChatSession(options: {
  store: SettingsStore;
  agents: AgentService;
  files: Pick<RulesSkills, "seenDirty" | "clearDirty">;
  emit: (event: FlowEvent) => void;
}): ChatSession {
  const { store, agents, files, emit } = options;
  let state: ChatStateName = store.view().setupComplete ? "ready" : "needsSetup";
  let run: RunRecord | null = null;
  let pending: Pending | null = null;
  let generation = 0;
  let shuttingDown = false;

  function emitState(): void {
    const event: FlowEvent = { type: "chat.state", runId: run?.id ?? "session", state };
    emit(event);
  }

  function refreshIdle(): void {
    if (state === "streaming" || state === "stopping" || state === "awaitingAnswer") return;
    state = store.view().setupComplete ? "ready" : "needsSetup";
  }

  function view(): Settings {
    refreshIdle();
    return store.view();
  }

  async function save(partial: { folder?: string; model?: string; theme?: Theme }): Promise<Settings> {
    if ((partial.folder !== undefined || partial.model !== undefined) && isBusy()) {
      throw new SessionError("conflict", "Wait for the current message to finish", false);
    }
    const previous = store.view().folder;
    let next: Settings;
    try {
      next = store.save(partial);
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
    if (next.folder !== previous) {
      closePending();
      await agents.dispose();
    }
    refreshIdle();
    emitState();
    return next;
  }

  async function setKey(key: string): Promise<void> {
    if (isBusy()) throw new SessionError("conflict", "Wait for the current message to finish", false);
    try {
      store.setKey(key);
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
    closePending();
    await agents.dispose();
    refreshIdle();
    emitState();
  }

  async function clearKey(): Promise<void> {
    if (isBusy()) throw new SessionError("conflict", "Wait for the current message to finish", false);
    store.clearKey();
    closePending();
    await agents.dispose();
    refreshIdle();
    emitState();
  }

  async function reset(): Promise<void> {
    if (shuttingDown) throw new SessionError("not_ready", "The app is closing", false);
    if (isBusy()) throw new SessionError("conflict", "Wait for the current message to finish", false);
    const current = store.view();
    if (current.folder === null) throw new SessionError("not_ready", "Choose a folder first", false);
    if (current.folderMissing) throw new SessionError("not_ready", "That folder is missing.", false);
    closePending();
    await agents.dispose();
    try {
      store.writeChat({ agentId: null, messages: [] });
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
    refreshIdle();
    emitState();
  }

  async function listModels(): Promise<{ id: string; label: string }[]> {
    const key = store.readKey();
    if (key === null) throw new SessionError("auth", "Save a Cursor key first", false);
    try {
      return await agents.listModels(key);
    } catch (error) {
      throw asSessionError(error);
    }
  }

  function history(): { messages: Message[] } {
    return { messages: store.readChat().messages };
  }

  function instructionsPending(): boolean {
    const folder = store.view().folder;
    return folder !== null && files.seenDirty(folder) !== 0;
  }

  function stateValue(): { state: ChatStateName; runId?: string; instructionsPending: boolean; pendingQuestion?: PendingQuestion } {
    refreshIdle();
    const instructions = instructionsPending();
    const question = pending === null ? null : publicQuestion(pending);
    const body = question === null ? { state, instructionsPending: instructions } : { state, instructionsPending: instructions, pendingQuestion: question };
    if (run && (state === "streaming" || state === "stopping" || state === "awaitingAnswer")) return { ...body, runId: run.id };
    return body;
  }

  async function send(text: string): Promise<{ runId: string; userMessageId: string; agentMessageId: string; restored: boolean }> {
    refreshIdle();
    if (isBusy()) throw new SessionError("conflict", "A message is already running", false);
    const current = store.view();
    const key = store.readKey();
    if (current.folderMissing) {
      state = "needsSetup";
      emitState();
      throw new SessionError("not_ready", "That folder is missing.", false);
    }
    if (!current.setupComplete || current.folder === null || current.model === null || key === null) {
      state = "needsSetup";
      emitState();
      throw new SessionError("not_ready", "Finish setup first", false);
    }

    agents.prepare();
    const prior = store.readChat();
    const seed = selectSeed(prior.messages);
    const seenInstructions = files.seenDirty(current.folder);
    const fresh = seenInstructions !== 0;
    const now = new Date().toISOString();
    const userMessage: Message = { id: randomUUID(), role: "user", text, at: now };
    const agentMessage: Message = { id: randomUUID(), role: "agent", text: "", at: now, status: "interrupted" };
    store.writeChat({ agentId: prior.agentId, messages: [...prior.messages, userMessage, agentMessage] });

    const nextGeneration = ++generation;
    run = {
      id: randomUUID(),
      agentMessageId: agentMessage.id,
      generation: nextGeneration,
      settled: false,
      abandoned: false,
      text: "",
    };
    state = "streaming";
    emitState();

    const ids = { runId: run.id, userMessageId: userMessage.id, agentMessageId: agentMessage.id };
    try {
      const ensured = await agents.ensure({
        apiKey: key,
        modelId: current.model,
        cwd: current.folder,
        agentId: fresh ? null : prior.agentId,
        fresh,
      });
      if (isStale(nextGeneration)) return { ...ids, restored: false };
      if (ensured.agentId !== prior.agentId) {
        const latest = store.readChat();
        store.writeChat({ agentId: ensured.agentId, messages: latest.messages });
      }
      if (fresh) files.clearDirty(current.folder, seenInstructions);
      const prompt = buildPrompt(text, fresh || ensured.restored ? seed : null);
      await agents.beginSend({
        apiKey: key,
        modelId: current.model,
        prompt,
        onEvent: (event) => handleStream(nextGeneration, event),
      });
      if (isStale(nextGeneration)) return { ...ids, restored: false };
      return { ...ids, restored: ensured.restored };
    } catch (error) {
      if (error instanceof Cancelled || isStale(nextGeneration)) {
        settle(nextGeneration, "stopped");
        return { ...ids, restored: false };
      }
      const failure = asSessionError(error);
      settle(nextGeneration, "error", failure);
      throw failure;
    }
  }

  async function stop(): Promise<void> {
    if (state === "stopping") return;
    if ((state !== "streaming" && state !== "awaitingAnswer") || run === null) {
      throw new SessionError("not_ready", "Nothing is running", false);
    }
    const current = run.generation;
    state = "stopping";
    run.abandoned = true;
    emitState();
    closePending();
    await agents.cancel();
    settle(current, "stopped");
  }

  function ask(request: AskRequest): Promise<string> {
    if (pending) return Promise.reject(new QuestionRejected("busy", QUESTION_BUSY));
    if (shuttingDown || state !== "streaming" || run === null || run.settled || run.abandoned) {
      return Promise.reject(new QuestionRejected("cancelled", QUESTION_CANCELLED));
    }
    const currentRun = run;
    const questionId = randomUUID();
    const message: Message = {
      id: questionId,
      role: "question",
      questionId,
      ...(request.title ? { title: request.title } : {}),
      questions: request.questions,
      answers: null,
      skipped: false,
      at: new Date().toISOString(),
    };
    try {
      const chat = store.readChat();
      store.writeChat({ agentId: chat.agentId, messages: insertBefore(chat.messages, currentRun.agentMessageId, message) });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("The question could not be saved"));
    }
    state = "awaitingAnswer";
    return new Promise((resolve, reject) => {
      pending = {
        questionId,
        questions: request.questions,
        resolve,
        reject,
        ...(request.title ? { title: request.title } : {}),
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      };
      emitState();
      emit({
        type: "question.asked",
        runId: currentRun.id,
        questionId,
        questions: request.questions,
        ...(request.title ? { title: request.title } : {}),
      });
    });
  }

  function answer(questionId: string, answers: Answers): void {
    const current = pending;
    if (current === null || current.questionId !== questionId) throw new SessionError("not_found", "That question is closed", false);
    const checked = checkAnswers(current.questions, answers);
    if (!checked.ok) throw new SessionError("invalid_input", checked.message, false);
    finish(current, "answered", answerJson(checked.value), (message) => ({ ...message, answers: checked.value, skipped: false }));
  }

  function skip(questionId: string): void {
    const current = pending;
    if (current === null || current.questionId !== questionId) throw new SessionError("not_found", "That question is closed", false);
    finish(current, "skipped", skipJson(), (message) => ({ ...message, answers: null, skipped: true }));
  }

  function finish(
    current: Pending,
    reason: "answered" | "skipped",
    result: string,
    patch: (message: Extract<Message, { role: "question" }>) => Message,
  ): void {
    if (run === null) throw new SessionError("not_found", "That question is closed", false);
    const chat = store.readChat();
    const messages = chat.messages.map((message): Message => {
      if (message.role !== "question" || message.questionId !== current.questionId) return message;
      return patch(message);
    });
    try {
      store.writeChat({ agentId: chat.agentId, messages });
    } catch (error) {
      throw new SessionError("io_error", errorText(error), false);
    }
    if (pending !== current) throw new SessionError("not_found", "That question is closed", false);
    pending = null;
    if (state === "awaitingAnswer") state = "streaming";
    emit({ type: "question.closed", runId: run.id, questionId: current.questionId, reason });
    emitState();
    current.resolve(result);
  }

  function closePending(): void {
    const current = pending;
    if (current === null) return;
    pending = null;
    emit({ type: "question.closed", runId: run?.id ?? "session", questionId: current.questionId, reason: "cancelled" });
    current.reject(new QuestionRejected("cancelled", QUESTION_CANCELLED));
  }

  function handleStream(current: number, event: AgentStreamEvent): void {
    if (run === null || run.generation !== current || run.settled) return;
    if (event.type === "delta") {
      run.text += event.text;
      emit({ type: "chat.delta", runId: run.id, messageId: run.agentMessageId, text: event.text });
      return;
    }
    if (event.type === "tool") {
      emit({
        type: "chat.tool",
        runId: run.id,
        toolCallId: event.toolCallId,
        name: event.name,
        status: event.status,
        summary: event.summary,
      });
      if (event.status !== "running") persistTool(current, event);
      return;
    }
    if (event.type === "error" || event.type === "done") {
      closePending();
      const stopped = run.abandoned || (event.type === "done" && event.stopReason === "stopped");
      if (run.abandoned) {
        settle(current, "stopped");
        return;
      }
      if (event.type === "done") {
        settle(current, stopped ? "stopped" : "end");
        return;
      }
      settle(current, "error", new SessionError(event.code, event.message, event.retryable));
    }
  }

  function persistTool(current: number, event: Extract<AgentStreamEvent, { type: "tool" }>): void {
    if (run === null || run.generation !== current) return;
    const agentMessageId = run.agentMessageId;
    const chat = store.readChat();
    const status: "ok" | "error" = event.status === "error" ? "error" : "ok";
    const existing = chat.messages.some((message) => message.id === event.toolCallId);
    const messages: Message[] = existing
      ? chat.messages.map((message): Message => {
          if (message.id !== event.toolCallId || message.role !== "tool") return message;
          return { id: message.id, role: "tool", name: event.name, summary: event.summary, status, at: message.at };
        })
      : insertTool(chat.messages, agentMessageId, {
          id: event.toolCallId,
          role: "tool",
          name: event.name,
          summary: event.summary,
          status,
          at: new Date().toISOString(),
        });
    store.writeChat({ agentId: chat.agentId, messages });
  }

  function settle(current: number, kind: "end" | "stopped" | "error", failure?: SessionError): void {
    if (run === null || run.generation !== current || run.settled) return;
    run.settled = true;
    const currentRun = run;
    const chat = store.readChat();
    const messages = chat.messages.map((message): Message => {
      if (message.id !== currentRun.agentMessageId || message.role !== "agent") return message;
      const status = kind === "end" ? "done" : kind === "stopped" ? "stopped" : "error";
      return { id: message.id, role: "agent", text: currentRun.text, at: message.at, status };
    });
    store.writeChat({ agentId: chat.agentId, messages });
    if (kind === "error" && failure) {
      emit({
        type: "chat.error",
        runId: currentRun.id,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      });
      if (failure.code === "auth") void agents.dispose();
    } else {
      emit({
        type: "chat.done",
        runId: currentRun.id,
        messageId: currentRun.agentMessageId,
        stopReason: kind === "stopped" ? "stopped" : "end",
      });
    }
    state = store.view().setupComplete ? "ready" : "needsSetup";
    emitState();
  }

  function isStale(current: number): boolean {
    return run === null || run.generation !== current || run.settled || run.abandoned;
  }

  function isBusy(): boolean {
    return state === "streaming" || state === "stopping" || state === "awaitingAnswer";
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (run && !run.settled) {
      run.abandoned = true;
      run.settled = true;
    }
    closePending();
    await Promise.race([agents.dispose(), new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
  }

  return {
    view,
    save,
    setKey,
    clearKey,
    listModels,
    reset,
    send,
    stop,
    ask,
    answer,
    skip,
    history,
    state: stateValue,
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}

function insertTool(messages: Message[], agentMessageId: string, tool: Message): Message[] {
  return insertBefore(messages, agentMessageId, tool);
}

function insertBefore(messages: Message[], agentMessageId: string, message: Message): Message[] {
  const next = [...messages];
  const index = next.findIndex((item) => item.id === agentMessageId);
  if (index === -1) next.push(message);
  else next.splice(index, 0, message);
  return next;
}

function publicQuestion(current: Pending): PendingQuestion {
  return {
    questionId: current.questionId,
    questions: current.questions,
    ...(current.title ? { title: current.title } : {}),
  };
}

function asSessionError(error: unknown): SessionError {
  if (error instanceof SessionError) return error;
  if (error instanceof AgentCallError) return new SessionError(error.code, error.message, error.retryable);
  return new SessionError("agent_error", errorText(error), false);
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.slice(0, 400);
  return "Something went wrong";
}
