import { useEffect, useRef, useState } from "react";
import {
  ciLabel,
  prsReady,
  relativeTime,
  reviewLabel,
  reviewPrompt,
  shortRepoName,
} from "../shared/github.js";
import type {
  GithubPr,
  GithubPrsResult,
  GithubStatus,
  Result,
} from "../shared/ipc.js";
import type { ReviewPhase } from "./state.js";

const REVIEW_POLL_MS = 2_000;

type Load =
  | { kind: "loading" }
  | { kind: "ready"; prs: GithubPr[]; total: number; checkout: string | null }
  | { kind: "error"; message: string; retryable: boolean };

type GitHubPrsProps = {
  status: GithubStatus | null;
  onBack: () => void;
  onSetup: () => void;
  /** Whether that workspace repo is running exactly this review message right now. */
  reviewPhase: (checkout: string, prompt: string) => ReviewPhase | null;
  /** Sends the review message to that workspace repo's agent. Resolves to an error text, or null when the run started. */
  onReview: (checkout: string, text: string) => Promise<string | null>;
  /** Opens that workspace repo's chat. */
  onOpenChat: (checkout: string) => void;
  /** Called when a tab shows a checkout, so a run already in progress there can be picked up. */
  onWatch: (checkout: string) => void;
};

type RunningReview = { repo: string; number: number };

function prLoad(result: Result<GithubPrsResult>): Load {
  return result.ok
    ? {
        kind: "ready",
        prs: result.value.prs,
        total: result.value.total,
        checkout: result.value.checkout,
      }
    : {
        kind: "error",
        message: result.error.message,
        retryable: result.error.retryable,
      };
}

function noteKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function GitHubPrs({ status, onBack, onSetup, reviewPhase, onReview, onOpenChat, onWatch }: GitHubPrsProps) {
  const ready = prsReady(status);
  const repos = status?.repos.selected ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [loads, setLoads] = useState<Partial<Record<string, Load>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const cache = useRef<Partial<Record<string, Load>>>({});
  const flights = useRef(new Map<string, Promise<Result<GithubPrsResult>>>());
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, "yes" | "no" | null>>(() => new Map());
  const wasRunning = useRef(new Map<string, RunningReview>());
  const reviewStarts = useRef(new Map<string, number>());
  const startingCheckouts = useRef(new Set<string>());
  const active = picked !== null && repos.includes(picked) ? picked : (repos[0] ?? null);
  const current = active === null ? undefined : loads[active];

  const activeCheckout = current?.kind === "ready" ? current.checkout : null;

  // Every review that is running now, over every loaded tab.
  const running: RunningReview[] = [];
  for (const repo of repos) {
    const load = loads[repo];
    if (load?.kind !== "ready" || load.checkout === null) continue;
    for (const pr of load.prs) {
      const prompt = reviewPrompt(repo, pr.number);
      if (prompt !== null && reviewPhase(load.checkout, prompt) !== null)
        running.push({ repo, number: pr.number });
    }
  }
  const runningKey = running
    .map((item) => noteKey(item.repo, item.number))
    .join(",");

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

  useEffect(() => {
    if (activeCheckout !== null) onWatch(activeCheckout);
  }, [activeCheckout]);

  function markSaved(repo: string, number: number, verdict: "yes" | "no" | null): void {
    const key = noteKey(repo, number);
    setSaved((all) => (all.has(key) ? all : new Set(all).add(key)));
    setVerdicts((all) => {
      if (all.has(key) && all.get(key) === verdict) return all;
      const next = new Map(all);
      next.set(key, verdict);
      return next;
    });
  }

  async function checkSaved(repo: string, number: number): Promise<boolean> {
    const result = await window.flow.invoke("flow:github.reviewReady", {
      repo,
      number,
    });
    if (!result.ok || !result.value.ready) return false;
    markSaved(repo, number, result.value.verdict);
    return true;
  }

  // While a review runs, look for its file every 2 seconds. This reads the disk in main, not GitHub.
  useEffect(() => {
    if (running.length === 0) return;
    const poll = (): void => {
      for (const item of running) void checkSaved(item.repo, item.number);
    };
    poll();
    const timer = window.setInterval(poll, REVIEW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [runningKey]);

  // A review that stopped running: look once more, and say so when there is still no file.
  // A tab that is reloading or failed keeps its entry, so a refresh is not mistaken for the end of a run.
  useEffect(() => {
    const now = new Map(
      running.map((item) => [noteKey(item.repo, item.number), item] as const),
    );
    for (const [key, item] of [...wasRunning.current]) {
      if (now.has(key) || loads[item.repo]?.kind !== "ready") continue;
      wasRunning.current.delete(key);
      const started = reviewStarts.current.get(key) ?? 0;
      void checkSaved(item.repo, item.number).then((ready) => {
        if (ready) return;
        if ((reviewStarts.current.get(key) ?? 0) !== started) return;
        setNotice(
          `The review of #${item.number} ended without pr-reviews/${item.number}.md. The agent cannot save a file in Plan mode.`,
        );
      });
    }
    for (const [key, item] of now) wasRunning.current.set(key, item);
  }, [runningKey, loads]);

  async function startReview(
    checkout: string,
    repo: string,
    number: number,
  ): Promise<void> {
    if (startingCheckouts.current.has(checkout)) return;
    const prompt = reviewPrompt(repo, number);
    if (prompt === null) return;
    const key = noteKey(repo, number);
    reviewStarts.current.set(key, (reviewStarts.current.get(key) ?? 0) + 1);
    setNotice(null);
    startingCheckouts.current.add(checkout);
    try {
      const failure = await onReview(checkout, prompt);
      if (failure !== null) {
        wasRunning.current.delete(key);
        setNotice(failure);
      }
    } finally {
      startingCheckouts.current.delete(checkout);
    }
  }

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
          {current.prs.map((pr) => {
            const checkout = current.checkout;
            const prompt = reviewPrompt(repo, pr.number);
            const phase =
              checkout === null || prompt === null
                ? null
                : reviewPhase(checkout, prompt);
            const hasNotes = pr.hasReview || saved.has(noteKey(repo, pr.number));
            const key = noteKey(repo, pr.number);
            const polled = verdicts.get(key);
            const verdict = polled !== undefined ? polled : pr.verdict;
            const canReview =
              !pr.approvedByYou &&
              checkout !== null &&
              prompt !== null &&
              phase === null;
            return (
              <li key={pr.number}>
                <div className={pr.approvedByYou ? "gh-pr approved-by-you" : "gh-pr"}>
                  <button
                    type="button"
                    className="gh-pr-open"
                    title={
                      pr.approvedByYou
                        ? "You approved this. Open in the browser"
                        : "Open in the browser"
                    }
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
                      {pr.approvedByYou ? (
                        <span className="ticket-chip gh-review-approved">
                          You approved
                        </span>
                      ) : null}
                      {pr.review !== null ? (
                        <span className={`ticket-chip gh-review-${pr.review}`}>
                          {reviewLabel(pr.review)}
                        </span>
                      ) : null}
                      {pr.ci !== null ? (
                        <span className={`ticket-chip gh-ci-${pr.ci}`}>
                          {ciLabel(pr.ci)}
                        </span>
                      ) : null}
                      {pr.updatedAt !== "" ? (
                        <span>{relativeTime(pr.updatedAt)}</span>
                      ) : null}
                    </span>
                  </button>
                  <div className="gh-pr-actions">
                    {phase === "running" ? (
                      <span className="gh-review-busy" role="status">
                        <span className="gh-spinner" aria-hidden="true" />
                        Reviewing…
                      </span>
                    ) : null}
                    {phase === "asking" && checkout !== null ? (
                      <button
                        type="button"
                        className="ticket-chip gh-review-link"
                        title="The agent is waiting for an answer"
                        onClick={() => onOpenChat(checkout)}
                      >
                        Answer in the chat
                      </button>
                    ) : null}
                    {verdict === "yes" || verdict === "no" ? (
                      <span
                        className={`ticket-chip gh-verdict-${verdict}`}
                        title={verdict === "yes" ? "The review says yes" : "The review says no"}
                      >
                        {verdict === "yes" ? "Yes" : "No"}
                      </span>
                    ) : null}
                    {hasNotes ? (
                      <button
                        type="button"
                        className="ticket-chip gh-review-link"
                        title={`Open pr-reviews/${pr.number}.md`}
                        onClick={() => void openReview(repo, pr.number)}
                      >
                        See review
                      </button>
                    ) : null}
                    {canReview ? (
                      <button
                        type="button"
                        className="btn gh-review-start"
                        title="Ask this repo's agent to review the pull request"
                        onClick={() => void startReview(checkout, repo, pr.number)}
                      >
                        Review
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
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
