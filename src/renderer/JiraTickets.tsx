import { useEffect, useState } from "react";
import type { JiraIssue, JiraStatus } from "../shared/ipc.js";
import {
  implementPrompt,
  issueBrowseUrl,
  jiraReady,
  siteLabel,
  ticketColumn,
  type TicketColumn,
} from "../shared/jira.js";
import { TicketBoard } from "./TicketBoard.js";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; issues: JiraIssue[]; next: string | null }
  | { kind: "error"; message: string; retryable: boolean };

type JiraTicketsProps = {
  status: JiraStatus | null;
  onBack: () => void;
  onSetup: () => void;
  onImplement: (text: string) => void;
};

export function JiraTickets({ status, onBack, onSetup, onImplement }: JiraTicketsProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ready = jiraReady(status);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLoad({ kind: "loading" });
    setNotice(null);
    void window.flow.invoke("flow:jira.issues", {}).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoad({
          kind: "error",
          message: result.error.message,
          retryable: result.error.retryable,
        });
        return;
      }
      setLoad({
        kind: "ready",
        issues: result.value.issues,
        next: result.value.nextPageToken ?? null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, attempt]);

  async function loadMore(token: string): Promise<void> {
    setLoadingMore(true);
    setNotice(null);
    const result = await window.flow.invoke("flow:jira.issues", {
      pageToken: token,
    });
    setLoadingMore(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    const page = result.value;
    setLoad((current) => {
      if (current.kind !== "ready") return current;
      const seen = new Set(current.issues.map((issue) => issue.key));
      return {
        kind: "ready",
        issues: [
          ...current.issues,
          ...page.issues.filter((issue) => !seen.has(issue.key)),
        ],
        next: page.nextPageToken ?? null,
      };
    });
  }

  async function openIssue(key: string): Promise<void> {
    setNotice(null);
    const result = await window.flow.invoke("flow:jira.open", { key });
    if (!result.ok) setNotice(result.error.message);
  }

  const label = siteLabel(status?.site ?? null);

  function ticketsBody() {
    if (status === null) {
      return (
        <p className="tickets-empty" role="status">
          Loading…
        </p>
      );
    }
    if (!ready) {
      return (
        <div className="tickets-empty">
          <p>Jira is not set up.</p>
          <button type="button" className="btn primary" onClick={onSetup}>
            Open Setup
          </button>
        </div>
      );
    }
    if (load.kind === "loading") {
      return (
        <p className="tickets-empty" role="status">
          Loading tickets…
        </p>
      );
    }
    if (load.kind === "error") {
      return (
        <div className="tickets-empty">
          <p role="alert">{load.message}</p>
          {load.retryable ? (
            <button
              type="button"
              className="btn primary"
              onClick={() => setAttempt((count) => count + 1)}
            >
              Retry
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={onSetup}>
              Open Setup
            </button>
          )}
        </div>
      );
    }
    if (load.issues.length === 0) {
      return <p className="tickets-empty">No open tickets are assigned to you.</p>;
    }
    const columns: Record<TicketColumn, JiraIssue[]> = {
      todo: [],
      progress: [],
      review: [],
    };
    for (const issue of load.issues) {
      columns[ticketColumn(issue.status, issue.statusCategory)].push(issue);
    }
    return (
      <TicketBoard
        columns={columns}
        next={load.next}
        loadingMore={loadingMore}
        onLoadMore={(token) => void loadMore(token)}
        renderCard={(issue) => {
          const url = status?.site != null ? issueBrowseUrl(status.site, issue.key) : null;
          return (
            <li key={issue.key} className="ticket-card">
              <button
                type="button"
                className="ticket"
                title="Open in the browser"
                onClick={() => void openIssue(issue.key)}
              >
                <span className="ticket-key">{issue.key}</span>
                <span className="ticket-summary">{issue.summary}</span>
                <span className="ticket-meta">
                  {issue.status !== "" ? <span className="ticket-chip">{issue.status}</span> : null}
                  {issue.type !== "" ? <span className="ticket-chip">{issue.type}</span> : null}
                  {issue.project !== "" ? <span className="ticket-chip">{issue.project}</span> : null}
                </span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={url === null}
                title={url === null ? "Ticket link is not available" : "Open a new chat for this ticket"}
                onClick={() => {
                  if (url !== null) onImplement(implementPrompt(url));
                }}
              >
                Implement
              </button>
            </li>
          );
        }}
      />
    );
  }

  return (
    <section className="tickets" aria-label="Jira tickets">
      <div className="tickets-head">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <div className="titles">
          <h2>Jira</h2>
          <span className="meta">Assigned to you, not done</span>
        </div>
        <div className="spacer">
          {label !== "" ? <span className="meta">{label}</span> : null}
          {ready ? (
            <button
              type="button"
              className="btn"
              disabled={load.kind === "loading" || loadingMore}
              onClick={() => setAttempt((count) => count + 1)}
            >
              Refresh
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onSetup}>
            Setup
          </button>
        </div>
      </div>
      {notice ? (
        <p className="error tickets-notice" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="tickets-body">{ticketsBody()}</div>
    </section>
  );
}
