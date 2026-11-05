// Zod contracts for the window and the main process. No I/O.
import { z } from "zod";
import { AnswersSchema, PendingQuestionSchema, QuestionSchema } from "./questions.js";

export const ErrorCodeSchema = z.enum([
  "not_allowed",
  "invalid_input",
  "not_ready",
  "not_found",
  "conflict",
  "auth",
  "agent_error",
  "io_error",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export type Failure = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

export const ThemeSchema = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const ChatStateSchema = z.enum(["needsSetup", "ready", "streaming", "stopping", "awaitingAnswer"]);
export type ChatStateName = z.infer<typeof ChatStateSchema>;

export const SettingsSchema = z.object({
  folder: z.string().nullable(),
  model: z.string().nullable(),
  theme: ThemeSchema,
  keySet: z.boolean(),
  /** The stored folder path is set, and that path is not a directory now. */
  folderMissing: z.boolean(),
  setupComplete: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const MessageSchema = z.discriminatedUnion("role", [
  z.object({
    id: z.string().min(1),
    role: z.literal("user"),
    text: z.string(),
    at: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("agent"),
    text: z.string(),
    at: z.string().min(1),
    status: z.enum(["done", "stopped", "interrupted", "error"]),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("tool"),
    name: z.string().min(1),
    summary: z.string(),
    status: z.enum(["ok", "error"]),
    at: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    role: z.literal("question"),
    questionId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    questions: z.array(QuestionSchema).min(1).max(8),
    answers: AnswersSchema.nullable(),
    skipped: z.boolean(),
    at: z.string().min(1),
  }),
]);
export type Message = z.infer<typeof MessageSchema>;

/** One path segment, 1–64 characters. The file service uses the same pattern. */
export const INSTRUCTION_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

const NameSchema = z
  .string()
  .regex(INSTRUCTION_NAME, "Use a lowercase name: letters, numbers, and hyphens")
  .max(64);

export const RuleSummarySchema = z.object({
  name: NameSchema,
  description: z.string(),
  alwaysApply: z.boolean(),
});
export type RuleSummary = z.infer<typeof RuleSummarySchema>;

export const RuleSchema = z.object({
  name: NameSchema,
  description: z.string().max(4_000),
  alwaysApply: z.boolean(),
  globs: z.string().max(1_000),
  body: z.string().max(200_000),
});
export type Rule = z.infer<typeof RuleSchema>;

export const SkillSummarySchema = z.object({
  name: NameSchema,
  description: z.string(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillSchema = z.object({
  name: NameSchema,
  description: z.string().max(4_000),
  body: z.string().max(200_000),
});
export type Skill = z.infer<typeof SkillSchema>;

const None = z.object({}).strict();

const SendResultSchema = z.object({
  runId: z.string().min(1),
  userMessageId: z.string().min(1),
  agentMessageId: z.string().min(1),
  restored: z.boolean(),
});

export type { Answers, PendingQuestion, Question } from "./questions.js";

export const COMMANDS = {
  "flow:settings.get": { input: None, output: SettingsSchema },
  "flow:settings.save": {
    input: z
      .object({
        folder: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        theme: ThemeSchema.optional(),
      })
      .strict(),
    output: SettingsSchema,
  },
  "flow:key.set": { input: z.object({ key: z.string().trim().min(1).max(500) }).strict(), output: None },
  "flow:key.clear": { input: None, output: None },
  "flow:folder.pick": { input: None, output: z.object({ folder: z.string().nullable() }) },
  "flow:models.list": {
    input: None,
    output: z.object({ models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })) }),
  },
  "flow:chat.send": {
    input: z.object({ text: z.string().trim().min(1).max(50_000) }).strict(),
    output: SendResultSchema,
  },
  "flow:chat.stop": { input: None, output: None },
  "flow:chat.history": { input: None, output: z.object({ messages: z.array(MessageSchema) }) },
  "flow:chat.reset": { input: None, output: None },
  "flow:chat.state": {
    input: None,
    output: z.object({
      state: ChatStateSchema,
      runId: z.string().min(1).optional(),
      instructionsPending: z.boolean(),
      pendingQuestion: PendingQuestionSchema.optional(),
    }),
  },
  "flow:question.answer": {
    input: z.object({ questionId: z.string().min(1).max(80), answers: AnswersSchema }).strict(),
    output: None,
  },
  "flow:question.skip": {
    input: z.object({ questionId: z.string().min(1).max(80) }).strict(),
    output: None,
  },
  "flow:rules.list": { input: None, output: z.array(RuleSummarySchema) },
  "flow:rules.read": { input: z.object({ name: NameSchema }).strict(), output: RuleSchema },
  "flow:rules.write": { input: RuleSchema.strict(), output: RuleSchema },
  "flow:rules.delete": { input: z.object({ name: NameSchema }).strict(), output: None },
  "flow:skills.list": { input: None, output: z.array(SkillSummarySchema) },
  "flow:skills.read": { input: z.object({ name: NameSchema }).strict(), output: SkillSchema },
  "flow:skills.write": { input: SkillSchema.strict(), output: SkillSchema },
  "flow:skills.delete": { input: z.object({ name: NameSchema }).strict(), output: None },
  "flow:agentsmd.read": { input: None, output: z.object({ body: z.string() }) },
  "flow:agentsmd.write": {
    input: z.object({ body: z.string().max(200_000) }).strict(),
    output: z.object({ body: z.string() }),
  },
} as const;

export type CommandChannel = keyof typeof COMMANDS;
export type InputOf<C extends CommandChannel> = z.infer<(typeof COMMANDS)[C]["input"]>;
export type OutputOf<C extends CommandChannel> = z.infer<(typeof COMMANDS)[C]["output"]>;

export const EVENT_CHANNEL = "flow:event";

const RunId = z.string().min(1);

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.state"), runId: RunId, state: ChatStateSchema }),
  z.object({
    type: z.literal("chat.delta"),
    runId: RunId,
    messageId: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    type: z.literal("chat.tool"),
    runId: RunId,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["running", "ok", "error"]),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("chat.done"),
    runId: RunId,
    messageId: z.string().min(1),
    stopReason: z.enum(["end", "stopped"]),
  }),
  z.object({
    type: z.literal("chat.error"),
    runId: RunId,
    code: ErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    type: z.literal("question.asked"),
    runId: RunId,
    questionId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    questions: z.array(QuestionSchema).min(1).max(8),
  }),
  z.object({
    type: z.literal("question.closed"),
    runId: RunId,
    questionId: z.string().min(1),
    reason: z.enum(["answered", "skipped", "cancelled"]),
  }),
]);

export type FlowEvent = z.infer<typeof EventSchema>;

export function isCommandChannel(value: string): value is CommandChannel {
  return Object.prototype.hasOwnProperty.call(COMMANDS, value);
}

export function failure(code: ErrorCode, message: string, retryable: boolean): Result<never> {
  return { ok: false, error: { code, message, retryable } };
}
