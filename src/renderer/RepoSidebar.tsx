import { useState } from "react";
import { Bot } from "./Bot.js";
import type { ChatFruit } from "./fruits.js";
import type { SidebarRow } from "./state.js";

type RepoSidebarProps = {
  rows: SidebarRow[];
  fruits: readonly ChatFruit[];
  pending: boolean;
  jiraActive: boolean;
  /** Show the Pull requests button. True only while the repos token is saved. */
  githubPrs: boolean;
  /** Show the Projects button. True only while the Projects token is saved. */
  githubProjects: boolean;
  prsActive: boolean;
  projectsActive: boolean;
  onOpen: (name: string) => void;
  onNew: () => void;
  onJira: () => void;
  onGithubPrs: () => void;
  onGithubProjects: () => void;
  onRemove: (name: string) => void;
};

export function RepoSidebar({
  rows,
  fruits,
  pending,
  jiraActive,
  githubPrs,
  githubProjects,
  prsActive,
  projectsActive,
  onOpen,
  onNew,
  onJira,
  onGithubPrs,
  onGithubProjects,
  onRemove,
}: RepoSidebarProps) {
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const confirming = rows.find((row) => row.name === confirmName) ?? null;
  const confirmBlocked = confirming === null || confirming.status === "running" || confirming.status === "waiting" || pending;

  return (
    <aside className="sidebar">
      <button type="button" className="btn" onClick={onNew}>
        New chat
      </button>
      <button type="button" className="btn" aria-current={jiraActive ? "page" : undefined} onClick={onJira}>
        Jira
      </button>
      {githubPrs ? (
        <button type="button" className="btn" aria-current={prsActive ? "page" : undefined} onClick={onGithubPrs}>
          Pull requests
        </button>
      ) : null}
      {githubProjects ? (
        <button type="button" className="btn" aria-current={projectsActive ? "page" : undefined} onClick={onGithubProjects}>
          Projects
        </button>
      ) : null}
      <ul className="repo-list">
        {rows.map((row, index) => {
          const blocked = row.status === "running" || row.status === "waiting" || pending;
          return (
            <li key={row.name} className="repo-item">
              <button
                type="button"
                className={row.active ? "repo-row active" : "repo-row"}
                aria-current={row.active ? "page" : undefined}
                onClick={() => onOpen(row.name)}
              >
                <span className="sr">{statusText(row.status)}</span>
                <Bot kind="agent" fruit={fruits[index] ?? "mango"} running={row.status === "running"} />
                <span className="repo-name">{row.name}</span>
                {row.unseen ? <span className="unseen">new</span> : null}
                <span className={`dot ${row.status}`} />
              </button>
              <button
                type="button"
                className="btn icon-btn repo-remove"
                title={`Remove ${row.name}`}
                aria-label={`Remove ${row.name}`}
                disabled={blocked}
                onClick={() => setConfirmName(row.name)}
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>
      {confirming ? (
        <div className="dialog-back">
          <div className="dialog" role="dialog" aria-labelledby="remove-title">
            <h2 id="remove-title">Remove chat</h2>
            <p>This clears the conversation for {confirming.name} and takes it off the list. The next message starts a new agent.</p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setConfirmName(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={confirmBlocked}
                onClick={() => {
                  const name = confirming.name;
                  setConfirmName(null);
                  onRemove(name);
                }}
              >
                Remove chat
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
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

function statusText(status: SidebarRow["status"]): string {
  if (status === "running") return "Running";
  if (status === "waiting") return "Waiting";
  if (status === "error") return "Error";
  return "Idle";
}
