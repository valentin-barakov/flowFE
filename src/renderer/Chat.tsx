import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMode, Answers, ChatStateName, Theme } from "../shared/ipc.js";
import { Bot } from "./Bot.js";
import type { ChatFruit } from "./fruits.js";
import { Markdown } from "./Markdown.js";
import { PlanCard } from "./PlanCard.js";
import { QuestionForm } from "./QuestionForm.js";
import { buildBlocks, type Block } from "./segments.js";
import { ModeSwitch, modelChoices, ThemeSwitch } from "./Setup.js";
import { SubagentCard } from "./SubagentCard.js";
import type { Banner, Item, ModelChoice } from "./state.js";
import { ToolStrip } from "./ToolStrip.js";

type ChatProps = {
  repoName: string;
  workspaceBusy: boolean;
  folder: string;
  model: string;
  mode: AgentMode;
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
  onMode: (mode: AgentMode) => void;
  onModel: (model: string) => Promise<boolean>;
  onReset: () => void;
  onSetup: () => void;
  onInstructions: () => void;
  /** Null when the left menu already has the Jira button. */
  onJira: (() => void) | null;
  /** Null when the left menu has the button, or the repos token is not saved. */
  onGithubPrs: (() => void) | null;
  /** Null when the left menu has the button, or the Projects token is not saved. */
  onGithubProjects: (() => void) | null;
  onDismiss: () => void;
  onRetry: () => void;
  onBannerSetup: () => void;
  onAnswer: (questionId: string, answers: Answers) => Promise<string | null>;
  onSkip: (questionId: string) => Promise<string | null>;
  fruit: ChatFruit;
};

export function Chat(props: ChatProps) {
  const busy = props.chatState === "streaming" || props.chatState === "stopping" || props.chatState === "awaitingAnswer";
  const threadRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const waiting = props.chatState === "awaitingAnswer";
  const liveId = busy ? lastAgent(props.items) : null;
  const blocks = useMemo(() => buildBlocks(props.items), [props.items]);
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
        <Bot kind="agent" fruit={props.fruit} running={busy} />
        <div className="titles">
          <h2>Mango</h2>
          <span className="meta" title={props.repoName === "." ? props.folder : props.repoName}>
            {props.repoName === "." ? folderName(props.folder) : props.repoName}
          </span>
        </div>
        <div className="spacer">
          <ModeSwitch mode={props.mode} disabled={busy || props.workspaceBusy || props.pending} onMode={props.onMode} />
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
          <button
            type="button"
            className="btn icon-btn"
            title="Reset chat"
            aria-label="Reset chat"
            disabled={busy || props.pending}
            onClick={() => setConfirmReset(true)}
          >
            <TrashIcon />
          </button>
          {props.onJira ? (
            <button type="button" className="btn" onClick={props.onJira}>
              Jira
            </button>
          ) : null}
          {props.onGithubPrs ? (
            <button type="button" className="btn" onClick={props.onGithubPrs}>
              Pull requests
            </button>
          ) : null}
          {props.onGithubProjects ? (
            <button type="button" className="btn" onClick={props.onGithubProjects}>
              Projects
            </button>
          ) : null}
          <button type="button" className="btn" onClick={props.onInstructions}>
            Rules
          </button>
          <button
            type="button"
            className="btn icon-btn"
            title="Setup"
            aria-label="Setup"
            disabled={busy || props.workspaceBusy}
            onClick={props.onSetup}
          >
            <GearIcon />
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
            <Bot kind="agent" fruit={props.fruit} large />
            <h2>No messages yet</h2>
            <p>Messages start here. The agent works in this repo.</p>
          </div>
        ) : (
          blocks.map((block) => (
            <BlockView
              key={block.key}
              block={block}
              liveId={liveId}
              models={props.models}
              selectedModel={props.model}
              stopping={props.chatState === "stopping"}
              waiting={waiting}
              fruit={props.fruit}
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

function BlockView({
  block,
  liveId,
  models,
  selectedModel,
  stopping,
  waiting,
  fruit,
  onAnswer,
  onSkip,
}: {
  block: Block;
  liveId: string | null;
  models: readonly ModelChoice[];
  selectedModel: string;
  stopping: boolean;
  waiting: boolean;
  fruit: ChatFruit;
  onAnswer: (questionId: string, answers: Answers) => Promise<string | null>;
  onSkip: (questionId: string) => Promise<string | null>;
}) {
  if (block.kind === "question") {
    const item = block.item;
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
  if (block.kind === "plan") {
    return <PlanCard markdown={block.plan} truncated={block.item.truncated === true} />;
  }
  if (block.kind === "subagent") {
    return (
      <SubagentCard
        item={block.item}
        live={block.agentId !== null && block.agentId === liveId}
        models={models}
        selectedModel={selectedModel}
      />
    );
  }
  if (block.kind === "tools") {
    return (
      <div className="tool-row">
        <ToolStrip tools={block.tools} live={block.agentId !== null && block.agentId === liveId} />
      </div>
    );
  }
  if (block.kind === "user") {
    return (
      <div className="bubble from-user">
        <Bot kind="user" />
        <div>
          <div className="who">You</div>
          <p>{block.item.text}</p>
        </div>
      </div>
    );
  }
  const agent = block.agent;
  const live = agent.id === liveId;
  const running = live && !stopping && !waiting;
  const status = live ? (stopping ? "stopping" : waiting ? "waiting" : "streaming") : agent.status;
  const empty = block.text === "";
  const note = block.last && !live ? endNote(agent.status, empty) : null;
  if (empty && !(block.last && live) && note === null) return null;
  return (
    <div className="bubble from-agent">
      {block.header ? <Bot kind="agent" fruit={fruit} running={running} /> : <span aria-hidden="true" />}
      <div>
        {block.header ? (
          <div className="who">
            Mango
            {status === "done" ? null : (
              <span className="pill" data-status={live ? "running" : status}>
                {status}
              </span>
            )}
          </div>
        ) : null}
        {empty ? (
          live ? (
            <p className="meta">{waiting ? "Waiting for an answer" : "Working…"}</p>
          ) : null
        ) : (
          <Markdown text={block.text} live={running && block.last} />
        )}
        {note !== null ? <p className="meta">{note}</p> : null}
      </div>
    </div>
  );
}

function endNote(status: "done" | "stopped" | "interrupted" | "error", empty: boolean): string | null {
  if (status === "interrupted") return "Interrupted when the app closed";
  if (!empty) return null;
  if (status === "stopped") return "Stopped";
  if (status === "error") return "The run failed";
  return null;
}

function lastAgent(items: readonly Item[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === "agent") return item.id;
  }
  return null;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 4.4h9.6" />
      <path d="M6.3 4.4V3.2a.7.7 0 0 1 .7-.7h2a.7.7 0 0 1 .7.7v1.2" />
      <path d="M4.5 4.4l.5 8a.8.8 0 0 0 .8.7h4.4a.8.8 0 0 0 .8-.7l.5-8" />
      <path d="M6.8 6.7v3.8M9.2 6.7v3.8" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 4.2h12M2 8h12M2 11.8h12" />
      <circle cx="5.2" cy="4.2" r="1.35" />
      <circle cx="10.8" cy="8" r="1.35" />
      <circle cx="6.4" cy="11.8" r="1.35" />
    </svg>
  );
}

function folderName(folder: string): string {
  const parts = folder.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? folder;
}
