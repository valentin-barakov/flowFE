import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  MAX_SELECTED_PROJECTS,
  MAX_SELECTED_REPOS,
  type GithubTokenKind,
} from "../shared/github.js";
import type { GithubProjectRef, GithubRepo, GithubStatus } from "../shared/ipc.js";

export type GitHubSetupProps = {
  status: GithubStatus | null;
  message: string | null;
  onSaveToken: (kind: GithubTokenKind, token: string) => Promise<boolean>;
  onClearToken: (kind: GithubTokenKind) => Promise<boolean>;
  onSelectRepos: (repos: string[]) => Promise<boolean>;
  onSelectProjects: (projects: GithubProjectRef[]) => Promise<boolean>;
};

export function GitHubSetup({
  status,
  message,
  onSaveToken,
  onClearToken,
  onSelectRepos,
  onSelectProjects,
  pending,
}: GitHubSetupProps & { pending: boolean }) {
  const busy = pending || status === null;
  return (
    <section className="setup-field">
      <label>GitHub (optional)</label>
      <p className="meta">
        Read-only lists of your pull requests and your personal projects. Each section has its own
        token and is shown only while its token is saved.
      </p>
      <div className="setup-notes">
        <p>
          Mango only reads. A classic <code>repo</code> token can also write to GitHub, so keep it
          on this Mac and set an expiry of 30 to 90 days.
        </p>
        <p>The tokens stay on this Mac. The app shows that they are saved, and never the token itself.</p>
      </div>

      <div className="gh-section">
        <TokenField
          id="github-repos-token"
          kind="repos"
          label="Pull requests token"
          note={
            <>
              Classic token with only <code>repo</code>. It covers private repos in your account and
              your organizations. Mango reads pull requests, review state, and CI state.
            </>
          }
          tokenSet={status?.repos.tokenSet === true}
          login={status?.repos.login ?? null}
          busy={busy}
          onSave={onSaveToken}
          onClear={onClearToken}
        />
        {status?.repos.tokenSet ? (
          <RepoPicker
            login={status.repos.login}
            selected={status.repos.selected}
            busy={busy}
            onSave={onSelectRepos}
          />
        ) : null}
      </div>

      <div className="gh-section">
        <TokenField
          id="github-projects-token"
          kind="projects"
          label="Projects token"
          note={
            <>
              Classic token with only <code>read:project</code>. A fine-grained token cannot read a
              personal project. Pasting one classic token with <code>repo</code> and{" "}
              <code>read:project</code> in both fields also works.
            </>
          }
          tokenSet={status?.projects.tokenSet === true}
          login={status?.projects.login ?? null}
          busy={busy}
          onSave={onSaveToken}
          onClear={onClearToken}
        />
        {status?.projects.tokenSet ? (
          <ProjectPicker
            login={status.projects.login}
            selected={status.projects.selected}
            busy={busy}
            onSave={onSelectProjects}
          />
        ) : null}
      </div>

      {message ? (
        <p className="error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function TokenField({
  id,
  kind,
  label,
  note,
  tokenSet,
  login,
  busy,
  onSave,
  onClear,
}: {
  id: string;
  kind: GithubTokenKind;
  label: string;
  note: ReactNode;
  tokenSet: boolean;
  login: string | null;
  busy: boolean;
  onSave: (kind: GithubTokenKind, token: string) => Promise<boolean>;
  onClear: (kind: GithubTokenKind) => Promise<boolean>;
}) {
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const showInput = !tokenSet || replacing;

  async function save(): Promise<void> {
    const value = token.trim();
    if (value === "") return;
    const ok = await onSave(kind, value);
    if (!ok) return;
    setToken("");
    setReplacing(false);
  }

  async function getToken(): Promise<void> {
    setNotice(null);
    const result = await window.flow.invoke("flow:github.openTokenPage", { kind });
    if (!result.ok) setNotice(result.error.message);
  }

  return (
    <>
      <label htmlFor={id}>{label}</label>
      {showInput ? (
        <div className="secret">
          <input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder={tokenSet ? "Paste a new token" : "Paste the token"}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="button"
            className="btn primary"
            disabled={busy || token.trim() === ""}
            onClick={() => void save()}
          >
            Save
          </button>
          {tokenSet ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setToken("");
                setReplacing(false);
              }}
            >
              Cancel
            </button>
          ) : null}
          <button type="button" className="btn" onClick={() => void getToken()}>
            Get token
          </button>
        </div>
      ) : (
        <div className="secret">
          <span className="key-state">Token saved</span>
          <button type="button" className="btn" disabled={busy} onClick={() => setReplacing(true)}>
            Replace
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void onClear(kind)}>
            Remove
          </button>
          <button type="button" className="btn" onClick={() => void getToken()}>
            Get token
          </button>
        </div>
      )}
      {tokenSet && login !== null ? <p className="meta">Signed in as {login}</p> : null}
      <p className="meta">{note}</p>
      {notice ? (
        <p className="error" role="alert">
          {notice}
        </p>
      ) : null}
    </>
  );
}

function RepoPicker({
  login,
  selected,
  busy,
  onSave,
}: {
  login: string | null;
  selected: string[];
  busy: boolean;
  onSave: (repos: string[]) => Promise<boolean>;
}) {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const combo = useRef<HTMLDivElement>(null);
  const selectedKey = selected.join("\n");

  useEffect(() => {
    let cancelled = false;
    setRepos(null);
    setError(null);
    void window.flow.invoke("flow:github.repos", {}).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRepos(result.value.repos);
      setTruncated(result.value.truncated);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, login]);

  useEffect(() => {
    setChecked(new Set(selected));
  }, [selectedKey]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const node = combo.current;
      if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle(name: string): void {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else if (next.size < MAX_SELECTED_REPOS) next.add(name);
      return next;
    });
  }

  async function remove(name: string): Promise<void> {
    setChecked((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    if (!selected.includes(name)) return;
    const saved = await onSave(selected.filter((repo) => repo !== name));
    if (!saved) setChecked((current) => new Set(current).add(name));
  }

  const known = new Set((repos ?? []).map((repo) => repo.fullName));
  const rows: GithubRepo[] = [
    ...(repos ?? []),
    ...selected
      .filter((name) => !known.has(name))
      .map((name) => ({ fullName: name, private: false, archived: false })),
  ];
  const needle = filter.trim().toLowerCase();
  const visible = rows.filter((row) => row.fullName.toLowerCase().includes(needle));
  const dirty = checked.size !== selected.length || selected.some((name) => !checked.has(name));

  return (
    <div className="gh-picker">
      <label htmlFor="github-repo-filter">Repositories for Pull requests</label>
      {error !== null ? (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <button type="button" className="btn" onClick={() => setAttempt((count) => count + 1)}>
            Retry
          </button>
        </div>
      ) : repos === null ? (
        <p className="meta" role="status">
          Loading repositories…
        </p>
      ) : (
        <>
          <div className="gh-combo" ref={combo}>
            <input
              id="github-repo-filter"
              type="text"
              className="gh-filter"
              autoComplete="off"
              spellCheck={false}
              placeholder="Filter"
              role="combobox"
              aria-expanded={open}
              aria-controls="github-repo-list"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onFocus={() => setOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            {open ? (
              <div id="github-repo-list" className="gh-list-box" role="group" aria-label="Repositories">
                {visible.length === 0 ? <p className="meta">No repositories match.</p> : null}
                {visible.map((row) => (
                  <label key={row.fullName} className="gh-option">
                    <input
                      type="checkbox"
                      checked={checked.has(row.fullName)}
                      disabled={!checked.has(row.fullName) && checked.size >= MAX_SELECTED_REPOS}
                      onChange={() => toggle(row.fullName)}
                    />
                    <span className="gh-name" title={row.fullName}>
                      {row.fullName}
                    </span>
                    {row.private ? <span className="ticket-chip">Private</span> : null}
                    {row.archived ? <span className="ticket-chip">Archived</span> : null}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <p className="meta">
            {checked.size} of {MAX_SELECTED_REPOS} selected
            {truncated ? ". The list is truncated: your token can see more repositories than are shown." : ""}
          </p>
          {checked.size > 0 ? (
            <ul className="gh-picks">
              {[...checked].sort().map((name) => (
                <li key={name}>
                  <span title={name}>{name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${name} from the watchlist`}
                    disabled={busy}
                    onClick={() => void remove(name)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !dirty}
              onClick={() => void onSave([...checked])}
            >
              Save repos
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function ProjectPicker({
  login,
  selected,
  busy,
  onSave,
}: {
  login: string | null;
  selected: GithubProjectRef[];
  busy: boolean;
  onSave: (projects: GithubProjectRef[]) => Promise<boolean>;
}) {
  const [projects, setProjects] = useState<GithubProjectRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected.map((project) => project.id)));
  const [attempt, setAttempt] = useState(0);
  const selectedKey = selected.map((project) => project.id).join("\n");

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
    setError(null);
    void window.flow.invoke("flow:github.projects", {}).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setProjects(result.value.projects);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, login]);

  useEffect(() => {
    setChecked(new Set(selected.map((project) => project.id)));
  }, [selectedKey]);

  function toggle(id: string): void {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SELECTED_PROJECTS) next.add(id);
      return next;
    });
  }

  const dirty =
    checked.size !== selected.length || selected.some((project) => !checked.has(project.id));

  return (
    <div className="gh-picker">
      <label>Projects for the Projects board</label>
      {error !== null ? (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <button type="button" className="btn" onClick={() => setAttempt((count) => count + 1)}>
            Retry
          </button>
        </div>
      ) : projects === null ? (
        <p className="meta" role="status">
          Loading projects…
        </p>
      ) : projects.length === 0 ? (
        <p className="meta">
          No open personal projects were found. A personal project needs a classic token with
          read:project.
        </p>
      ) : (
        <>
          <div className="gh-list-box" role="group" aria-label="Projects">
            {projects.map((project) => (
              <label key={project.id} className="gh-option">
                <input
                  type="checkbox"
                  checked={checked.has(project.id)}
                  disabled={!checked.has(project.id) && checked.size >= MAX_SELECTED_PROJECTS}
                  onChange={() => toggle(project.id)}
                />
                <span className="gh-name" title={project.title}>
                  {project.title}
                </span>
              </label>
            ))}
          </div>
          <p className="meta">
            {checked.size} of {MAX_SELECTED_PROJECTS} selected
          </p>
          <p className="actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !dirty}
              onClick={() =>
                void onSave(projects.filter((project) => checked.has(project.id)))
              }
            >
              Save projects
            </button>
          </p>
        </>
      )}
    </div>
  );
}
