import { useEffect, useState, type FormEvent } from "react";
import type { Answers, Question } from "../shared/ipc.js";
import { checkAnswers } from "../shared/questions.js";

type Draft = Record<string, { selected: string[]; other: string }>;

type QuestionFormProps = {
  title?: string;
  questions: Question[];
  answers: Answers | null;
  open: boolean;
  skipped: boolean;
  cancelled: boolean;
  onAnswer: (answers: Answers) => Promise<string | null>;
  onSkip: () => Promise<string | null>;
};

export function QuestionForm(props: QuestionFormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(props.questions, props.answers));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const shown = props.answers ?? draft;
  const status = props.cancelled ? "Cancelled" : props.skipped ? "Skipped" : props.open ? null : "Answered";

  useEffect(() => {
    if (!props.open) setSubmitting(false);
  }, [props.open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!props.open || submitting) return;
    const checked = checkAnswers(props.questions, draftAnswers(props.questions, draft));
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setSubmitting(true);
    const message = await props.onAnswer(checked.value);
    if (message !== null) {
      setError(message);
      setSubmitting(false);
    }
  }

  async function skip() {
    if (!props.open || submitting) return;
    setError(null);
    setSubmitting(true);
    const message = await props.onSkip();
    if (message !== null) {
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <form className="question-card" data-state={status === null ? "open" : status.toLowerCase()} onSubmit={(event) => void submit(event)}>
      {props.title ? <h3>{props.title}</h3> : null}
      {status ? <p className="question-status">{status}</p> : null}
      <fieldset disabled={!props.open || submitting}>
        {props.questions.map((question, index) => (
          <div className="question-block" key={question.id}>
            <p>{question.prompt}</p>
            {question.options.map((option) => {
              const multiple = question.allow_multiple === true;
              return (
                <label className="choice" key={option.id}>
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={question.id}
                    value={option.id}
                    checked={selectedOf(shown, question.id).includes(option.id)}
                    autoFocus={props.open && index === 0 && option === question.options[0]}
                    onChange={() => setDraft((current) => toggle(current, question, option.id))}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
            <label className="other">
              Other
              <input
                type="text"
                maxLength={2000}
                value={otherOf(shown, question.id)}
                onChange={(event) => setDraft((current) => setOther(current, question.id, event.target.value))}
              />
            </label>
          </div>
        ))}
        <div className="actions">
          <button type="submit" className="btn primary" disabled={!props.open || submitting}>
            Submit
          </button>
          <button type="button" className="btn" disabled={!props.open || submitting} onClick={() => void skip()}>
            Skip
          </button>
        </div>
      </fieldset>
      {props.open && error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function selectedOf(shown: Answers | Draft, questionId: string): string[] {
  return shown[questionId]?.selected ?? [];
}

function otherOf(shown: Answers | Draft, questionId: string): string {
  return shown[questionId]?.other ?? "";
}

function draftFrom(questions: readonly Question[], answers: Answers | null): Draft {
  const draft: Draft = {};
  for (const question of questions) {
    const answer = answers?.[question.id];
    draft[question.id] = { selected: answer?.selected.slice() ?? [], other: answer?.other ?? "" };
  }
  return draft;
}

function draftAnswers(questions: readonly Question[], draft: Draft): Answers {
  const answers: Answers = {};
  for (const question of questions) {
    const row = draft[question.id] ?? { selected: [], other: "" };
    const other = row.other.trim();
    answers[question.id] = other === "" ? { selected: row.selected } : { selected: row.selected, other };
  }
  return answers;
}

function toggle(draft: Draft, question: Question, optionId: string): Draft {
  const row = draft[question.id] ?? { selected: [], other: "" };
  const multiple = question.allow_multiple === true;
  const selected = multiple
    ? row.selected.includes(optionId)
      ? row.selected.filter((id) => id !== optionId)
      : [...row.selected, optionId]
    : [optionId];
  return { ...draft, [question.id]: { ...row, selected } };
}

function setOther(draft: Draft, questionId: string, other: string): Draft {
  const row = draft[questionId] ?? { selected: [], other: "" };
  return { ...draft, [questionId]: { ...row, other } };
}
