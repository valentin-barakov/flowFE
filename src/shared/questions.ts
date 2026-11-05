// Question tool args and form answers. No I/O. Main and the renderer both use this.
import { z } from "zod";

const IdSchema = z.string().trim().min(1, "Each id must be a non-empty string.").max(80, "Ids must be at most 80 characters.");

export const QuestionOptionSchema = z.object({
  id: IdSchema,
  label: z.string().trim().min(1, "Each option needs a label.").max(500, "Option labels must be at most 500 characters."),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.object({
  id: IdSchema,
  prompt: z.string().trim().min(1, "Each question needs a prompt.").max(2_000, "Prompts must be at most 2000 characters."),
  options: z.array(QuestionOptionSchema).min(1, "Each question needs at least one option.").max(20, "A question can have at most 20 options."),
  allow_multiple: z.boolean().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AnswerSchema = z.object({
  selected: z.array(z.string().min(1).max(80)).max(20),
  other: z.string().max(2_000, "Other text is too long.").optional(),
});

export const AnswersSchema = z.record(z.string().min(1).max(80), AnswerSchema);
export type Answers = z.infer<typeof AnswersSchema>;

export const PendingQuestionSchema = z.object({
  questionId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  questions: z.array(QuestionSchema).min(1).max(8),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

const ToolInputSchema = z.object({
  title: z.string().trim().min(1, "The title must not be empty.").max(200, "The title must be at most 200 characters.").optional(),
  questions: z.array(QuestionSchema).min(1, "Ask at least one question.").max(8, "Ask at most 8 questions at once."),
});

export type Asked = {
  title?: string;
  questions: Question[];
};

export type AskRequest = Asked & {
  toolCallId?: string;
};

export type AskUser = (request: AskRequest) => Promise<string>;

export class QuestionRejected extends Error {
  readonly reason: "busy" | "cancelled";

  constructor(reason: "busy" | "cancelled", message: string) {
    super(message);
    this.name = "QuestionRejected";
    this.reason = reason;
  }
}

export const QUESTION_BUSY = "a question is already open";
export const QUESTION_CANCELLED = "The question was cancelled.";

export function parseToolQuestion(input: unknown): { ok: true; value: Asked } | { ok: false; message: string } {
  const parsed = ToolInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "The question was not valid." };
  const seenQuestions = new Set<string>();
  for (const question of parsed.data.questions) {
    if (seenQuestions.has(question.id)) return { ok: false, message: "Each question needs its own id." };
    seenQuestions.add(question.id);
    const seenOptions = new Set<string>();
    for (const option of question.options) {
      if (seenOptions.has(option.id)) return { ok: false, message: "Each option needs its own id." };
      seenOptions.add(option.id);
    }
  }
  const title = parsed.data.title;
  const questions = parsed.data.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    options: question.options.map((option) => ({ id: option.id, label: option.label })),
    ...(question.allow_multiple === undefined ? {} : { allow_multiple: question.allow_multiple }),
  }));
  return { ok: true, value: { questions, ...(title ? { title } : {}) } };
}

export function checkAnswers(questions: readonly Question[], answers: Answers): { ok: true; value: Answers } | { ok: false; message: string } {
  const expected = new Set(questions.map((question) => question.id));
  for (const key of Object.keys(answers)) {
    if (!expected.has(key)) return { ok: false, message: "Answer the questions on the form." };
  }
  const value: Answers = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) return { ok: false, message: "Answer every question on the form." };
    const other = answer.other?.trim() ?? "";
    if (other.length > 2_000) return { ok: false, message: "Other text is too long." };
    const optionIds = new Set(question.options.map((option) => option.id));
    const selected: string[] = [];
    for (const id of answer.selected) {
      if (!optionIds.has(id)) return { ok: false, message: "Pick an option from the list." };
      if (!selected.includes(id)) selected.push(id);
    }
    if (question.allow_multiple !== true && selected.length > 1) return { ok: false, message: "Pick one option." };
    if (selected.length === 0 && other === "") return { ok: false, message: "Pick an option or type an answer." };
    value[question.id] = other === "" ? { selected } : { selected, other };
  }
  return { ok: true, value };
}

export function answerJson(answers: Answers): string {
  return JSON.stringify(answers);
}

export function skipJson(): string {
  return JSON.stringify({ skipped: true });
}
