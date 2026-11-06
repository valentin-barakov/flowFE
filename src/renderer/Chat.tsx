import { useEffect, useRef, useState } from "react";
import type { Answers, ChatStateName, Theme } from "../shared/ipc.js";
import { Bot } from "./Bot.js";
import { QuestionForm } from "./QuestionForm.js";
import { modelChoices, ThemeSwitch } from "./Setup.js";
import type { Banner, Item, ModelChoice } from "./state.js";

type ChatProps = {
  repoName: string;
  workspaceBusy: boolean;
  folder: string;
  model: string;
  models: ModelChoice[];
  theme: Theme;
  items: Item[];
  chatState: ChatStateName;
  draft: string;
  notice: string | null;
  banner: Banner | null;
  pending: boolean;
  canRetry: boolean;
  instructionsPending: boolean;
  onDraft: (draft: string) => void;
  onSend: () => void;
  onStop: () => void;
  onTheme: (theme: Theme) => void;
  onModel: (model: string) => Promise<boolean>;
  onReset: () => void;
  onSetup: () => void;
  onInstructions: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  onBannerSetup: () => void;
  onAnswer: (questionId: string, answers: Answers) => Promise<string | null>;
  onSkip: (questionId: string) => Promise<string | null>;
};

export function Chat(props: ChatProps) {
  const busy = props.chatState === "streaming" || props.chatState === "stopping" || props.chatState === "awaitingAnswer";
  const threadRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const waiting = props.chatState === "awaitingAnswer";
  const liveId = busy ? lastAgent(props.items) : null;
  const [confirmReset, setConfirmReset] = useState(false);
  const choices = modelChoices(props.models, props.model === "" ? null : props.model);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !stickRef.current) return;
    thread.scrollTop = thread.scrollHeight;
  }, [props.items, props.chatState]);

  return (
    <section className="chat">
      <div className="thread-head">
        <Bot kind="agent" running={busy} />
        <div className="titles">
          <h2>Mango</h2>
          <span className="meta" title={props.repoName === "." ? props.folder : props.repoName}>
            {props.repoName === "." ? folderName(props.folder) : props.repoName}
          </span>
        </div>
        <div className="spacer">
          <label className="sr" htmlFor="header-model">
            Model
          </label>
          <select
            id="header-model"
            className="model-picker"
            value={props.model}
            disabled={busy || props.workspaceBusy || props.pending || choices.length === 0}
            onChange={(event) => {
              const model = event.target.value;
              if (model !== "" && model !== props.model) void props.onModel(model);
            }}
          >
            {choices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <ThemeSwitch theme={props.theme} onTheme={props.onTheme} />
          <button type="button" className="btn" disabled={busy || props.pending} onClick={() => setConfirmReset(true)}>
            Reset chat
          </button>
          <button type="button" className="btn" onClick={props.onInstructions}>
            Rules
          </button>
          <button type="button" className="btn" disabled={busy || props.workspaceBusy} onClick={props.onSetup}>
            Setup
          </button>
        </div>
      </div>
      {confirmReset ? (
        <div className="dialog-back">
          <div className="dialog" role="dialog" aria-labelledby="reset-title">
            <h2 id="reset-title">Reset chat</h2>
            <p>This clears the conversation for this repo. The next message starts a new agent.</p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setConfirmReset(false);
                  props.onReset();
                }}
              >
                Reset chat
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {props.banner ? (
        <div className="banners">
          <div className="banner" role="status">
            <strong>{props.banner.title}</strong>
            {props.banner.body}
            <span className="actions">
              {props.canRetry ? (
                <button type="button" className="btn" onClick={props.onRetry}>
                  Retry
                </button>
              ) : null}
              {props.banner.setup ? (
                <button type="button" className="btn" onClick={props.onBannerSetup}>
                  Setup
                </button>
              ) : null}
              <button type="button" className="btn" onClick={props.onDismiss}>
                Dismiss
              </button>
            </span>
          </div>
        </div>
      ) : null}
      <div
        className="thread"
        ref={threadRef}
        aria-label="Conversation"
        onScroll={() => {
          const thread = threadRef.current;
          if (!thread) return;
          stickRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
        }}
      >
        {props.items.length === 0 ? (
          <div className="empty">
            <Bot kind="agent" large />
            <h2>No messages yet</h2>
            <p>Messages start here. The agent works in this repo.</p>
          </div>
        ) : (
          props.items.map((item) => (
            <Row
              key={item.role === "question" ? item.questionId : item.id}
              item={item}
              live={item.id === liveId}
              stopping={props.chatState === "stopping"}
              waiting={waiting}
              onAnswer={props.onAnswer}
              onSkip={props.onSkip}
            />
          ))
        )}
      </div>
      {waiting ? <p className="notice">The agent is waiting for an answer.</p> : null}
      {props.instructionsPending ? <p className="notice">Saved rules and skills apply to the next message.</p> : null}
      {props.notice ? <p className="notice">{props.notice}</p> : null}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) props.onSend();
        }}
      >
        <label className="sr" htmlFor="draft">
          Message
        </label>
        <textarea
          id="draft"
          rows={2}
          placeholder="Message Mango"
          value={props.draft}
          disabled={busy}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            if (!busy) props.onSend();
          }}
        />
        {busy ? (
          <button type="button" className="btn danger" disabled={props.chatState === "stopping"} onClick={props.onStop}>
            {props.chatState === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={props.pending || props.draft.trim() === ""}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}

function Row({
  item,
  live,
  stopping,
  waiting,
  onAnswer,
  onSkip,
}: {
  item: Item;
  live: boolean;
  stopping: boolean;
  waiting: boolean;
  onAnswer: (questionId: string, answers: Answers) => Promise<string | null>;
  onSkip: (questionId: string) => Promise<string | null>;
}) {
  if (item.role === "question") {
    return (
      <QuestionForm
        {...(item.title !== undefined ? { title: item.title } : {})}
        questions={item.questions}
        answers={item.answers}
        open={item.open}
        skipped={item.skipped}
        cancelled={item.cancelled}
        onAnswer={(answers) => onAnswer(item.questionId, answers)}
        onSkip={() => onSkip(item.questionId)}
      />
    );
  }
  if (item.role === "tool") {
    const phase = item.status === "ok" ? "finished" : item.status === "error" ? "failed" : "running";
    const label = item.status === "ok" ? "done" : item.status === "error" ? "failed" : "running";
    const text = [item.name, label, item.summary].filter((part) => part !== "").join(" · ");
    return (
      <div className="tool-row">
        <div className="tool" data-phase={phase}>
          {text}
        </div>
      </div>
    );
  }
  if (item.role === "user") {
    return (
      <div className="bubble from-user">
        <Bot kind="user" />
        <div>
          <div className="who">You</div>
          <p>{item.text}</p>
        </div>
      </div>
    );
  }
  const status = live ? (stopping ? "stopping" : waiting ? "waiting" : "streaming") : item.status;
  const showCaret = live && !stopping && !waiting;
  return (
    <div className="bubble from-agent">
      <Bot kind="agent" running={live && !stopping && !waiting} />
      <div>
        <div className="who">
          Mango
          {status === "done" ? null : (
            <span className="pill" data-status={status === "streaming" || status === "stopping" || status === "waiting" ? "running" : status}>
              {status === "streaming" ? "streaming" : status === "stopping" ? "stopping" : status === "waiting" ? "waiting" : status}
            </span>
          )}
        </div>
        {item.text === "" && live ? (
          <p className="meta">{waiting ? "Waiting for an answer" : "Working…"}</p>
        ) : (
          <p className={showCaret ? "caret" : undefined}>{item.text}</p>
        )}
        {item.status === "interrupted" && !live ? <p className="meta">Interrupted when the app closed</p> : null}
      </div>
    </div>
  );
}

function lastAgent(items: readonly Item[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === "agent") return item.id;
  }
  return null;
}

function folderName(folder: string): string {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? folder;
}
