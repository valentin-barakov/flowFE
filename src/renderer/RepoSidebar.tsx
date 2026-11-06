import { useState } from "react";
import type { SidebarRow } from "./state.js";

type RepoSidebarProps = {
  rows: SidebarRow[];
  pending: boolean;
  onOpen: (name: string) => void;
  onNew: () => void;
  onRemove: (name: string) => void;
};

export function RepoSidebar({ rows, pending, onOpen, onNew, onRemove }: RepoSidebarProps) {
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const confirming = rows.find((row) => row.name === confirmName) ?? null;
  const confirmBlocked = confirming === null || confirming.status === "running" || confirming.status === "waiting" || pending;

  return (
    <aside className="sidebar">
      <button type="button" className="btn" onClick={onNew}>
        New chat
      </button>
      <ul className="repo-list">
        {rows.map((row) => {
          const blocked = row.status === "running" || row.status === "waiting" || pending;
          return (
            <li key={row.name} className="repo-item">
              <button
                type="button"
                className={row.active ? "repo-row active" : "repo-row"}
                aria-current={row.active ? "page" : undefined}
                onClick={() => onOpen(row.name)}
              >
                <span className={`dot ${row.status}`} />
                <span className="sr">{statusText(row.status)}</span>
                <span className="repo-name">{row.name}</span>
                {row.unseen ? <span className="unseen">new</span> : null}
              </button>
              <button
                type="button"
                className="btn repo-remove"
                aria-label={`Remove ${row.name}`}
                disabled={blocked}
                onClick={() => setConfirmName(row.name)}
              >
                Remove
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

function statusText(status: SidebarRow["status"]): string {
  if (status === "running") return "Running";
  if (status === "waiting") return "Waiting";
  if (status === "error") return "Error";
  return "Idle";
}
