// The only file that imports @cursor/sdk. It turns SDK messages into Mango events.
import {
  Agent,
  AuthenticationError,
  Cursor,
  CursorAgentError,
  type AgentOptions,
  type ModelListItem,
  type ModelSelection,
  type Run,
  type SDKCustomTool,
  type SDKJsonValue,
  type SDKMessage,
  type SendOptions,
} from "@cursor/sdk";
import { PLAN_TEXT_MAX, type AgentMode, type Subagent } from "../shared/ipc.js";
import { isCreatePlan } from "../shared/plan-markdown.js";
import { parseToolQuestion, QuestionRejected, type AskUser } from "../shared/questions.js";
import { isTask } from "../shared/task.js";
import { taskActivity, taskFields, toolDetail } from "./tool-summary.js";

const RESUME_TIMEOUT_MS = 10_000;

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

export class AgentCallError extends Error {
  readonly code: "auth" | "agent_error";
  readonly retryable: boolean;

  constructor(code: "auth" | "agent_error", message: string, retryable: boolean) {
    super(message);
    this.name = "AgentCallError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      status: "running" | "ok" | "error";
      summary: string;
      plan?: string;
      truncated?: boolean;
      subagent?: Subagent;
    }
  | { type: "done"; stopReason: "end" | "stopped" }
  | { type: "error"; code: "auth" | "agent_error"; message: string; retryable: boolean };

type EnsureInput = {
  apiKey: string;
  modelId: string;
  cwd: string;
  agentId: string | null;
  /** Skip the in-memory agent and Agent.resume so the next create reads the project files again. */
  fresh: boolean;
  mode: AgentMode;
};

type SendInput = {
  apiKey: string;
  modelId: string;
  prompt: string;
  mode: AgentMode;
  onEvent: (event: AgentStreamEvent) => void;
};

export type AgentService = {
  prepare(): void;
  listModels(apiKey: string): Promise<{ id: string; label: string }[]>;
  ensure(input: EnsureInput): Promise<{ agentId: string; restored: boolean }>;
  beginSend(input: SendInput): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
};

export function createAgentService(hooks: { ask: AskUser }): AgentService {
  let holder: { agent: { agentId: string; send: SendFn; [Symbol.asyncDispose](): Promise<void> }; cwd: string } | null = null;
  let activeRun: Run | null = null;
  let cancelRequested = false;
  let epoch = 0;

  function prepare(): void {
    cancelRequested = false;
  }

  let catalogKey = "";
  let catalogModels: ModelListItem[] = [];

  async function loadCatalog(apiKey: string): Promise<readonly ModelListItem[]> {
    if (catalogKey === apiKey && catalogModels.length > 0) return catalogModels;
    const models = await Cursor.models.list({ apiKey });
    catalogKey = apiKey;
    catalogModels = models;
    return models;
  }

  async function selectionFor(apiKey: string, modelId: string): Promise<ModelSelection> {
    try {
      return modelSelection(modelId, await loadCatalog(apiKey));
    } catch (error) {
      throw translate(error, apiKey);
    }
  }

  async function listModels(apiKey: string): Promise<{ id: string; label: string }[]> {
    try {
      return listedModels(await loadCatalog(apiKey));
    } catch (error) {
      throw translate(error, apiKey);
    }
  }

  async function ensure(input: EnsureInput): Promise<{ agentId: string; restored: boolean }> {
    const seen = epoch;
    if (!input.fresh && holder && holder.cwd === input.cwd) {
      return { agentId: holder.agent.agentId, restored: false };
    }
    if (holder) await disposeHolder();
    if (cancelRequested || seen !== epoch) throw new Cancelled();

    const options = await agentOptions(input, hooks.ask, selectionFor);
    if (!input.fresh && input.agentId !== null) {
      try {
        const agent = await resumeWithTimeout(input.agentId, options, RESUME_TIMEOUT_MS);
        if (cancelRequested || seen !== epoch) {
          await agent[Symbol.asyncDispose]().catch(() => undefined);
          throw new Cancelled();
        }
        holder = { agent, cwd: input.cwd };
        return { agentId: agent.agentId, restored: false };
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        if (seen !== epoch) throw new Cancelled();
      }
    }

    if (cancelRequested || seen !== epoch) throw new Cancelled();
    let agent: Awaited<ReturnType<typeof Agent.create>>;
    try {
      agent = await Agent.create(options);
    } catch (error) {
      throw translate(error, input.apiKey);
    }
    if (cancelRequested || seen !== epoch) {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
      throw new Cancelled();
    }
    holder = { agent, cwd: input.cwd };
    return { agentId: agent.agentId, restored: !input.fresh && input.agentId !== null };
  }

  async function beginSend(input: SendInput): Promise<void> {
    const seen = epoch;
    const current = holder;
    if (current === null) throw new AgentCallError("agent_error", "The agent is not open", true);
    if (cancelRequested) throw new Cancelled();
    const activities = new Map<string, string>();
    const finished = new Set<string>();
    let run: Run;
    try {
      run = await current.agent.send(input.prompt, {
        model: await selectionFor(input.apiKey, input.modelId),
        mode: input.mode,
        local: { customTools: questionTools(hooks.ask) },
        // The run stream drops nested task updates. onDelta is how the card learns what the subagent is doing.
        onDelta: ({ update }) => {
          const next = taskActivity(update, current.cwd);
          if (next === null || finished.has(next.callId)) return;
          const previous = activities.get(next.callId);
          if (previous === next.line) return;
          if (previous !== undefined && !next.replace) return;
          activities.set(next.callId, next.line);
          input.onEvent({
            type: "tool",
            toolCallId: next.callId,
            name: "task",
            status: "running",
            summary: "",
            subagent: { activity: next.line },
          });
        },
      });
    } catch (error) {
      throw translate(error, input.apiKey);
    }
    if (cancelRequested || seen !== epoch || holder !== current) {
      if (run.supports("cancel")) await run.cancel().catch(() => undefined);
      throw new Cancelled();
    }
    activeRun = run;
    void consume(run, input.apiKey, current.cwd, input.onEvent, activities, finished).finally(() => {
      if (activeRun === run) activeRun = null;
    });
  }

  async function cancel(): Promise<void> {
    cancelRequested = true;
    const run = activeRun;
    if (run && run.supports("cancel")) await run.cancel().catch(() => undefined);
  }

  async function dispose(): Promise<void> {
    epoch += 1;
    cancelRequested = true;
    const run = activeRun;
    activeRun = null;
    if (run && run.supports("cancel")) await run.cancel().catch(() => undefined);
    await disposeHolder();
    cancelRequested = false;
  }

  async function disposeHolder(): Promise<void> {
    const current = holder;
    holder = null;
    if (current) await current.agent[Symbol.asyncDispose]().catch(() => undefined);
  }

  return { prepare, listModels, ensure, beginSend, cancel, dispose };
}

type SendFn = (message: string, options?: SendOptions) => Promise<Run>;

const ASK_TOOL_DESCRIPTION =
  "Ask the user to choose and wait for their answer. Use this for any decision that needs the user. " +
  "Pass questions: each has id, prompt, options (id and label), and allow_multiple when several options may be chosen. " +
  "An optional title is shown above the form. " +
  'The result is JSON. A skip is {"skipped":true}. An answer is an object keyed by question id, each value {"selected":[option ids],"other"?:string}.';

const ASK_INPUT_SCHEMA: Record<string, SDKJsonValue> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short heading above the questions." },
    questions: {
      type: "array",
      description: "One or more questions shown together on one form.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          prompt: { type: "string" },
          allow_multiple: { type: "boolean", description: "When true the user may pick more than one option." },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"],
            },
          },
        },
        required: ["id", "prompt", "options"],
      },
    },
  },
  required: ["questions"],
};

function questionTools(ask: AskUser): Record<string, SDKCustomTool> {
  return { ask_user_question: questionTool(ask) };
}

function questionTool(ask: AskUser): SDKCustomTool {
  return {
    description: ASK_TOOL_DESCRIPTION,
    inputSchema: ASK_INPUT_SCHEMA,
    execute: async (args, context) => {
      const parsed = parseToolQuestion(args);
      if (!parsed.ok) return toolError(parsed.message);
      const toolCallId = context.toolCallId;
      try {
        return await ask({
          questions: parsed.value.questions,
          ...(parsed.value.title ? { title: parsed.value.title } : {}),
          ...(toolCallId ? { toolCallId } : {}),
        });
      } catch (error) {
        if (error instanceof QuestionRejected) return toolError(error.message);
        const message = error instanceof Error && error.message.trim() !== "" ? error.message : "The question failed";
        return toolError(message.slice(0, 400));
      }
    },
  };
}

function toolError(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

/** A catalog id stays `{ id }`. `<id>-<value>` is that model's variant, sent as the catalog id plus its parameters. */
export function modelSelection(modelId: string, models: readonly ModelListItem[]): ModelSelection {
  if (models.some((model) => model.id === modelId)) return { id: modelId };
  for (const model of models) {
    const variant = model.variants?.find((item) => variantChoiceId(model.id, item.params) === modelId);
    if (variant) return { id: model.id, params: variant.params };
    if (model.aliases?.includes(modelId)) return { id: model.id };
  }
  return { id: modelId };
}

/** Catalog ids, plus one row per single-parameter variant (`<id>-<value>`), plus any other alias. */
export function listedModels(models: readonly ModelListItem[]): { id: string; label: string }[] {
  const seen = new Set<string>();
  const listed: { id: string; label: string }[] = [];
  const add = (id: string, label: string) => {
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    listed.push({ id, label: label.trim() === "" ? id : label.trim() });
  };
  for (const model of models) {
    const name = model.displayName.trim() === "" ? model.id : model.displayName.trim();
    add(model.id, name);
    for (const variant of model.variants ?? []) {
      if (variant.isDefault) continue;
      const choiceId = variantChoiceId(model.id, variant.params);
      if (choiceId === null) continue;
      const variantName = variant.displayName.trim();
      add(choiceId, variantName === "" || name.includes(variantName) ? name : `${name} (${variantName})`);
    }
    for (const alias of model.aliases ?? []) add(alias, alias);
  }
  listed.sort((a, b) => a.label.localeCompare(b.label));
  return listed;
}

function variantChoiceId(modelId: string, params: readonly { value: string }[]): string | null {
  if (params.length !== 1) return null;
  const value = params[0]?.value ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  const choice = `${modelId}-${value}`;
  return choice === modelId ? null : choice;
}

async function agentOptions(input: EnsureInput, ask: AskUser, selectionFor: (apiKey: string, modelId: string) => Promise<ModelSelection>): Promise<AgentOptions> {
  const settingSources: Array<"project" | "user"> = ["project", "user"];
  return {
    apiKey: input.apiKey,
    model: await selectionFor(input.apiKey, input.modelId),
    mode: input.mode,
    local: { cwd: input.cwd, settingSources, customTools: questionTools(ask) },
  };
}

async function resumeWithTimeout(agentId: string, options: AgentOptions, ms: number) {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await new Promise<Awaited<ReturnType<typeof Agent.resume>>>((resolve, reject) => {
    timer = setTimeout(() => {
      settled = true;
      reject(new Error("resume timed out"));
    }, ms);
    Agent.resume(agentId, options).then(
      (agent) => {
        if (settled) {
          void agent[Symbol.asyncDispose]().catch(() => undefined);
          return;
        }
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(agent);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function consume(
  run: Run,
  secret: string,
  cwd: string,
  onEvent: (event: AgentStreamEvent) => void,
  activities: ReadonlyMap<string, string>,
  finished: Set<string>,
): Promise<void> {
  let accumulated = "";
  try {
    for await (const message of run.stream()) {
      emitMessage(message, accumulated, cwd, (next, event) => {
        accumulated = next;
        if (event?.type === "tool" && isTask(event.name) && event.status !== "running") finished.add(event.toolCallId);
        if (event) onEvent(event);
      }, activities);
    }
    const result = await run.wait();
    if (result.status === "cancelled") {
      onEvent({ type: "done", stopReason: "stopped" });
      return;
    }
    if (result.status === "error") {
      onEvent({
        type: "error",
        code: "agent_error",
        message: scrub(result.error?.message ?? "The run failed", secret),
        retryable: false,
      });
      return;
    }
    onEvent({ type: "done", stopReason: "end" });
  } catch (error) {
    if (error instanceof Cancelled) {
      onEvent({ type: "done", stopReason: "stopped" });
      return;
    }
    const failure = translate(error, secret);
    onEvent({ type: "error", code: failure.code, message: failure.message, retryable: failure.retryable });
  }
}

export function emitMessage(
  message: SDKMessage,
  accumulated: string,
  cwd: string,
  emit: (accumulated: string, event: AgentStreamEvent | null) => void,
  activities?: ReadonlyMap<string, string>,
): void {
  if (message.type === "assistant") {
    let next = accumulated;
    for (const block of message.message.content) {
      if (block.type !== "text" || block.text === "") continue;
      const piece = block.text.startsWith(next) ? block.text.slice(next.length) : block.text;
      next = block.text.startsWith(next) ? block.text : next + block.text;
      if (piece !== "") emit(next, { type: "delta", text: piece });
    }
    return;
  }
  if (message.type !== "tool_call") return;
  const name = message.name.trim() === "" ? "tool" : message.name;
  // The question card is how this call is shown, so it gets no tool line.
  if (isQuestionTool(name, message.args) || isQuestionTool(name, message.result)) return;
  const toolCallId = message.call_id.trim() === "" ? `${name}-call` : message.call_id;
  const status = message.status === "completed" ? "ok" : message.status === "error" ? "error" : "running";
  const task = isTask(name) ? taskFields(message.args) : null;
  const summary = isCreatePlan(name) ? planSummary(status) : task !== null ? task.description : toolDetail(message.args, cwd, name);
  const activity = activities?.get(toolCallId);
  emit(accumulated, {
    type: "tool",
    toolCallId,
    name,
    status,
    summary,
    ...subagentFields(name, task, activity),
    ...planFields(name, message),
  });
}

function subagentFields(
  name: string,
  task: { description: string; model?: string } | null,
  activity: string | undefined,
): { subagent?: Subagent } {
  if (!isTask(name)) return {};
  const subagent: Subagent = {
    ...(task !== null ? { description: task.description } : {}),
    ...(task?.model !== undefined ? { model: task.model } : {}),
    ...(activity !== undefined && activity !== "" ? { activity } : {}),
  };
  if (subagent.description === undefined && subagent.model === undefined && subagent.activity === undefined) return {};
  return { subagent };
}

function planSummary(status: "running" | "ok" | "error"): string {
  if (status === "running") return "Writing a plan";
  if (status === "error") return "The plan failed";
  return "Plan";
}

function planFields(name: string, message: Extract<SDKMessage, { type: "tool_call" }>): { plan?: string; truncated?: boolean } {
  if (!isCreatePlan(name) || message.status !== "completed") return {};
  const text = readPlan(message.args);
  if (text === null) return {};
  const over = text.length > PLAN_TEXT_MAX;
  const plan = over ? text.slice(0, PLAN_TEXT_MAX) : text;
  if (over || message.truncated?.args === true) return { plan, truncated: true };
  return { plan };
}

function readPlan(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const plan = (value as { plan?: unknown }).plan;
  if (typeof plan !== "string") return null;
  return plan === "" ? null : plan;
}

function isQuestionTool(name: string, value: unknown): boolean {
  if (name.toLowerCase().replaceAll("-", "_").includes("ask_user_question")) return true;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["toolName", "name", "tool"]) {
    const item = record[key];
    if (typeof item === "string" && item.includes("ask_user_question")) return true;
  }
  return false;
}

function translate(error: unknown, secret: string): AgentCallError {
  if (error instanceof Cancelled || error instanceof AgentCallError) {
    if (error instanceof AgentCallError) return error;
    throw error;
  }
  if (error instanceof AuthenticationError) return new AgentCallError("auth", "Key rejected", false);
  const retryable = error instanceof CursorAgentError ? error.isRetryable : false;
  const message = error instanceof Error ? error.message : "The agent failed";
  return new AgentCallError("agent_error", scrub(message, secret), retryable);
}

function scrub(message: string, secret: string): string {
  const cleaned = secret === "" ? message : message.split(secret).join("[redacted]");
  return cleaned.slice(0, 400);
}
