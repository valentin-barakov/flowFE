import { useEffect, useState } from "react";
import type { JiraStatus } from "../shared/ipc.js";

export type JiraSetupProps = {
  status: JiraStatus | null;
  message: string | null;
  onSave: (input: {
    email: string;
    site: string;
    token?: string;
  }) => Promise<boolean>;
  onClear: () => Promise<boolean>;
};

export function JiraSetup({
  status,
  message,
  onSave,
  onClear,
  pending,
}: JiraSetupProps & { pending: boolean }) {
  const [email, setEmail] = useState(status?.email ?? "");
  const [site, setSite] = useState(status?.site ?? "");
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const tokenSet = status?.tokenSet === true;
  const showToken = !tokenSet || replacing;
  const busy = pending || status === null;

  useEffect(() => {
    setEmail(status?.email ?? "");
    setSite(status?.site ?? "");
  }, [status?.email, status?.site]);

  async function save(): Promise<void> {
    const next: { email: string; site: string; token?: string } = {
      email: email.trim(),
      site: site.trim(),
    };
    if (showToken) {
      if (token.trim() === "") return;
      next.token = token.trim();
    }
    const ok = await onSave(next);
    if (!ok) return;
    setToken("");
    setReplacing(false);
  }

  return (
    <section className="setup-field">
      <label>Jira (optional)</label>
      <p className="meta">
        A read-only list of your open tickets. Create an API token, then paste
        your Atlassian email, the site, and the token.
      </p>
      <div className="setup-notes">
        <p>
          Create a token at{" "}
          <code>
            https://id.atlassian.com/manage-profile/security/api-tokens
          </code>
        </p>
        <p>
          The token can do everything that account can do in Jira. Mango only
          reads the tickets assigned to you and opens them in the browser. You
          can set an expiry when you create the token.
        </p>
        <p>
          The token stays on this Mac. The app shows that it is saved, and never
          the token itself.
        </p>
      </div>

      <label htmlFor="jira-email">Atlassian email</label>
      <input
        id="jira-email"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={email}
        placeholder="you@example.com"
        onChange={(event) => setEmail(event.target.value)}
      />

      <label htmlFor="jira-site">Site</label>
      <input
        id="jira-site"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={site}
        placeholder="https://your-site.atlassian.net"
        onChange={(event) => setSite(event.target.value)}
      />

      <label htmlFor="jira-token">API token</label>
      {showToken ? (
        <div className="secret">
          <input
            id="jira-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder={tokenSet ? "Paste a new token" : "Paste the API token"}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="button"
            className="btn primary"
            disabled={
              busy ||
              email.trim() === "" ||
              site.trim() === "" ||
              token.trim() === ""
            }
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
        </div>
      ) : (
        <div className="secret">
          <span className="key-state">Token saved</span>
          <button
            type="button"
            className="btn"
            disabled={busy || email.trim() === "" || site.trim() === ""}
            onClick={() => void save()}
          >
            Save
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setReplacing(true)}
          >
            Replace
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => void onClear()}
          >
            Remove
          </button>
        </div>
      )}
      {message ? (
        <p className="error" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  );
}
