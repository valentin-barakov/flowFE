import { useEffect, useRef, useState } from "react";
import {
  ciLabel,
  prsReady,
  relativeTime,
  reviewLabel,
  shortRepoName,
} from "../shared/github.js";
import type { GithubPr, GithubPrsResult, GithubStatus, Result } from "../shared/ipc.js";

type Load =
  | { kind: "loading" }
  | { kind: "ready"; prs: GithubPr[]; total: number }
  | { kind: "error"; message: string; retryable: boolean };

type GitHubPrsProps = {
  status: GithubStatus | null;
  onBack: () => void;
  onSetup: () => void;
};

function prLoad(result: Result<GithubPrsResult>): Load {
  return result.ok
    ? { kind: "ready", prs: result.value.prs, total: result.value.total }
    : { kind: "error", message: result.error.message, retryable: result.error.retryable };
}

export function GitHubPrs({ status, onBack, onSetup }: GitHubPrsProps) {
  const ready = prsReady(status);
  const repos = status?.repos.selected ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [loads, setLoads] = useState<Partial<Record<string, Load>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const cache = useRef<Partial<Record<string, Load>>>({});
  const flights = useRef(new Map<string, Promise<Result<GithubPrsResult>>>());
  const active = picked !== null && repos.includes(picked) ? picked : (repos[0] ?? null);
  const current = active === null ? undefined : loads[active];

  function startFlight(repo: string): Promise<Result<GithubPrsResult>> {
    const existing = flights.current.get(repo);
    if (existing !== undefined) return existing;
    const flight = window.flow.invoke("flow:github.prs", { repo });
    flights.current.set(repo, flight);
    void flight.then((result) => {
      if (flights.current.get(repo) !== flight) return;
      flights.current.delete(repo);
      cache.current[repo] = prLoad(result);
    });
    return flight;
  }

  async function load(repo: string): Promise<void> {
    flights.current.delete(repo);
    delete cache.current[repo];
    setLoads((all) => ({ ...all, [repo]: { kind: "loading" } }));
    const flight = startFlight(repo);
    await flight;
    const next = cache.current[repo];
    if (next === undefined) return;
    setLoads((all) => ({ ...all, [repo]: next }));
  }

  useEffect(() => {
    if (!ready || active === null) return;
    const repo = active;
    const saved = cache.current[repo];
    if (saved !== undefined) {
      setLoads((all) => (all[repo] === saved ? all : { ...all, [repo]: saved }));
      return;
    }
    let cancelled = false;
    const flight = startFlight(repo);
    setLoads((all) => (all[repo] !== undefined ? all : { ...all, [repo]: { kind: "loading" } }));
    void flight.then((result) => {
      if (cancelled) return;
      setLoads((all) => ({ ...all, [repo]: cache.current[repo] ?? prLoad(result) }));
    });
    return () => {
      cancelled = true;
    };
  }, [ready, active]);

  async function openPr(repo: string, number: number): Promise<void> {
    setNotice(null);
    const result = await window.flow.invoke("flow:github.open", { repo, kind: "pr", number });
    if (!result.ok) setNotice(result.error.message);
  }

  async function openReview(repo: string, number: number): Promise<void> {
    setNotice(null);
    const result = await window.flow.invoke("flow:github.openReview", { repo, number });
    if (!result.ok) setNotice(result.error.message);
  }

  function body() {
    if (status === null) {
      return (
        <p className="tickets-empty" role="status">
          Loading…
        </p>
      );
    }
    if (!ready || repos.length === 0 || active === null) {
      return (
        <div className="tickets-empty">
          <p>{ready ? "No repositories are selected." : "GitHub pull requests are not set up."}</p>
          <button type="button" className="btn primary" onClick={onSetup}>
            Open Setup
          </button>
        </div>
      );
    }
    return (
      <>
        <div className="gh-tabs" aria-label="Repositories">
          {repos.map((repo) => {
            const state = loads[repo];
            return (
              <button
                key={repo}
                type="button"
                className="gh-tab"
                aria-current={repo === active ? "true" : undefined}
                title={repo}
                onClick={() => setPicked(repo)}
              >
                {shortRepoName(repo)}
                {state?.kind === "ready" ? <span className="gh-count">{state.total}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="gh-panel" aria-label={active}>
          {panel(active)}
        </div>
      </>
    );
  }

  function panel(repo: string) {
    if (current === undefined || current.kind === "loading") {
      return (
        <p className="tickets-empty" role="status">
          Loading pull requests…
        </p>
      );
    }
    if (current.kind === "error") {
      return (
        <div className="tickets-empty">
          <p role="alert">{current.message}</p>
          {current.retryable ? (
            <button type="button" className="btn primary" onClick={() => void load(repo)}>
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
    if (current.prs.length === 0) {
      return <p className="tickets-empty">No open PRs</p>;
    }
    return (
      <>
        <ul className="gh-list">
          {current.prs.map((pr) => (
            <li key={pr.number}>
              <div className={pr.approvedByYou ? "gh-pr approved-by-you" : "gh-pr"}>
                <button
                  type="button"
                  className="gh-pr-open"
                  title={pr.approvedByYou ? "You approved this. Open in the browser" : "Open in the browser"}
                  onClick={() => void openPr(repo, pr.number)}
                >
                  <span className="gh-pr-title">
                    <span className="ticket-key">#{pr.number}</span> {pr.title}
                  </span>
                  <span className="ticket-meta">
                    {pr.author !== "" ? <span>{pr.author}</span> : null}
                    <span>
                      {pr.headRefName} → {pr.baseRefName}
                    </span>
                    {pr.isDraft ? <span className="ticket-chip">Draft</span> : null}
                    {pr.approvedByYou ? <span className="ticket-chip gh-review-approved">You approved</span> : null}
                    {pr.review !== null ? (
                      <span className={`ticket-chip gh-review-${pr.review}`}>{reviewLabel(pr.review)}</span>
                    ) : null}
                    {pr.ci !== null ? (
                      <span className={`ticket-chip gh-ci-${pr.ci}`}>{ciLabel(pr.ci)}</span>
                    ) : null}
                    {pr.updatedAt !== "" ? <span>{relativeTime(pr.updatedAt)}</span> : null}
                  </span>
                </button>
                {pr.hasReview ? (
                  <button
                    type="button"
                    className="ticket-chip gh-review-link"
                    title={`Open pr-reviews/${pr.number}.md`}
                    onClick={() => void openReview(repo, pr.number)}
                  >
                    Review notes
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {current.total > current.prs.length ? (
          <p className="meta">
            {current.prs.length} of {current.total}
          </p>
        ) : null}
      </>
    );
  }

  const loading = current === undefined || current.kind === "loading";

  return (
    <section className="tickets" aria-label="Pull requests">
      <div className="tickets-head">
        <button type="button" className="btn" onClick={onBack}>
          Back
        </button>
        <div className="titles">
          <h2>Pull requests</h2>
          <span className="meta">Open pull requests in the repos you picked</span>
        </div>
        <div className="spacer">
          {status?.repos.login != null ? <span className="meta">{status.repos.login}</span> : null}
          {ready && active !== null ? (
            <button type="button" className="btn" disabled={loading} onClick={() => void load(active)}>
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
      <div className="tickets-body">{body()}</div>
    </section>
  );
}
