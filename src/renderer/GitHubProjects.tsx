import { useEffect, useState } from "react";
import { itemUrl, projectColumn, projectsReady, shortRepoName } from "../shared/github.js";
import type { GithubItem, GithubStatus } from "../shared/ipc.js";
import { implementPrompt, type TicketColumn } from "../shared/jira.js";
import { TicketBoard } from "./TicketBoard.js";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; items: GithubItem[]; next: string | null }
  | { kind: "error"; message: string; retryable: boolean };

type GitHubProjectsProps = {
  status: GithubStatus | null;
  onBack: () => void;
  onSetup: () => void;
  onImplement: (text: string) => void;
};

const KIND_LABEL = { issue: "Issue", pr: "PR", draft: "Draft" } as const;

function linkOf(item: GithubItem): string | null {
  if (item.kind === "draft" || item.repo === null || item.number === null) return null;
  return itemUrl(item.repo, item.kind, item.number);
}

function keyOf(item: GithubItem): string {
  if (item.repo === null || item.number === null) return "Draft";
  return `${item.repo}#${item.number}`;
}

export function GitHubProjects({ status, onBack, onSetup, onImplement }: GitHubProjectsProps) {
  const ready = projectsReady(status);
  const projects = status?.projects.selected ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const active = projects.find((project) => project.id === picked) ?? projects[0] ?? null;
  const activeId = active?.id ?? null;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || activeId === null) return;
    let cancelled = false;
    setLoad({ kind: "loading" });
    setNotice(null);
    void window.flow.invoke("flow:github.projectItems", { projectId: activeId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoad({ kind: "error", message: result.error.message, retryable: result.error.retryable });
        return;
      }
      setLoad({ kind: "ready", items: result.value.items, next: result.value.nextCursor ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, activeId, attempt]);

  async function loadMore(cursor: string): Promise<void> {
    if (activeId === null) return;
    setLoadingMore(true);
    setNotice(null);
    const result = await window.flow.invoke("flow:github.projectItems", {
      projectId: activeId,
      cursor,
    });
    setLoadingMore(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    const page = result.value;
    setLoad((current) => {
      if (current.kind !== "ready") return current;
      const seen = new Set(current.items.map((item) => item.id));
      return {
        kind: "ready",
        items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))],
        next: page.nextCursor ?? null,
      };
    });
  }

  async function openItem(item: GithubItem): Promise<void> {
    if (item.kind === "draft" || item.repo === null || item.number === null) return;
    setNotice(null);
    const result = await window.flow.invoke("flow:github.open", {
      repo: item.repo,
      kind: item.kind,
      number: item.number,
    });
    if (!result.ok) setNotice(result.error.message);
  }

  function itemsBody() {
    if (status === null) {
      return (
        <p className="tickets-empty" role="status">
          Loading…
        </p>
      );
    }
    if (!ready || active === null) {
      return (
        <div className="tickets-empty">
          <p>{ready ? "No projects are selected." : "GitHub projects are not set up."}</p>
          <button type="button" className="btn primary" onClick={onSetup}>
            Open Setup
          </button>
        </div>
      );
    }
    if (load.kind === "loading") {
      return (
        <p className="tickets-empty" role="status">
          Loading items…
        </p>
      );
    }
    if (load.kind === "error") {
      return (
        <div className="tickets-empty">
          <p role="alert">{load.message}</p>
          {load.retryable ? (
            <button type="button" className="btn primary" onClick={() => setAttempt((count) => count + 1)}>
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
    if (load.items.length === 0 && load.next === null) {
      return <p className="tickets-empty">No open items in this project.</p>;
    }
    const columns: Record<TicketColumn, GithubItem[]> = { todo: [], progress: [], review: [] };
    for (const item of load.items) columns[projectColumn(item.status)].push(item);
    return (
      <TicketBoard
        columns={columns}
        next={load.next}
        loadingMore={loadingMore}
        onLoadMore={(cursor) => void loadMore(cursor)}
        renderCard={(item) => {
          const url = linkOf(item);
          return (
            <li key={item.id} className="ticket-card">
              <button
                type="button"
                className="ticket"
                title={url === null ? "A draft item has no page to open" : "Open in the browser"}
                disabled={url === null}
                onClick={() => void openItem(item)}
              >
                <span className="ticket-key">{keyOf(item)}</span>
                <span className="ticket-summary">{item.title}</span>
                <span className="ticket-meta">
                  {item.status !== "" ? <span className="ticket-chip">{item.status}</span> : null}
                  {item.kind !== "draft" ? <span className="ticket-chip">{KIND_LABEL[item.kind]}</span> : null}
                  {item.repo !== null ? <span className="ticket-chip">{shortRepoName(item.repo)}</span> : null}
                </span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={url === null}
                title={url === null ? "A draft item has no link" : "Open a new chat for this item"}
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
    <section className="tickets" aria-label="GitHub projects">
      <div className="tickets-head">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <div className="titles">
          <h2>Projects</h2>
          <span className="meta">{active !== null ? `${active.title}: open items` : "Open items"}</span>
        </div>
        <div className="spacer">
          {projects.length > 1 ? (
            <>
              <label className="sr" htmlFor="github-project-switch">
                Project
              </label>
              <select
                id="github-project-switch"
                value={active?.id ?? ""}
                disabled={load.kind === "loading" || loadingMore}
                onChange={(event) => setPicked(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {ready && active !== null ? (
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
      <div className="tickets-body">{itemsBody()}</div>
    </section>
  );
}
