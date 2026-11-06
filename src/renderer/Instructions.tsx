import { useEffect, useRef, useState } from "react";
import { RulesEditor } from "./RulesEditor.js";
import { SkillsEditor } from "./SkillsEditor.js";
import type { Banner } from "./state.js";

type Mode = "rules" | "skills" | "agents";

type InstructionsProps = {
  repo: string;
  banner: Banner | null;
  canRetry: boolean;
  onBack: () => void;
  onChanged: () => Promise<boolean>;
  onDismiss: () => void;
  onRetry: () => void;
  onSetup: () => void;
};

export function Instructions({ repo, banner, canRetry, onBack, onChanged, onDismiss, onRetry, onSetup }: InstructionsProps) {
  const [mode, setMode] = useState<Mode>("rules");
  const dirty = useRef({ rules: false, skills: false, agents: false });

  function back(): void {
    const unsaved = dirty.current.rules || dirty.current.skills || dirty.current.agents;
    if (unsaved && !window.confirm("Discard unsaved changes?")) return;
    onBack();
  }

  return (
    <section className="editor">
      <div className="thread-head">
        <button type="button" className="back" onClick={back}>
          Chat
        </button>
        <div className="titles">
          <h2>Rules and skills</h2>
          <span className="meta">Saved changes apply to the next message</span>
        </div>
      </div>
      {banner ? (
        <div className="banners">
          <div className="banner" role="status">
            <strong>{banner.title}</strong>
            {banner.body}
            <span className="actions">
              {canRetry ? (
                <button type="button" className="btn" onClick={onRetry}>
                  Retry
                </button>
              ) : null}
              {banner.setup ? (
                <button type="button" className="btn" onClick={onSetup}>
                  Setup
                </button>
              ) : null}
              <button type="button" className="btn" onClick={onDismiss}>
                Dismiss
              </button>
            </span>
          </div>
        </div>
      ) : null}
      <div className="mode-switch" role="tablist" aria-label="Instruction files">
        <button type="button" role="tab" aria-current={mode === "rules" ? "true" : undefined} onClick={() => setMode("rules")}>
          Rules
        </button>
        <button type="button" role="tab" aria-current={mode === "skills" ? "true" : undefined} onClick={() => setMode("skills")}>
          Skills
        </button>
        <button type="button" role="tab" aria-current={mode === "agents" ? "true" : undefined} onClick={() => setMode("agents")}>
          AGENTS.md
        </button>
      </div>
      <div className="editor-pane" hidden={mode !== "rules"}>
        <RulesEditor repo={repo} onChanged={onChanged} onDirty={(value) => { dirty.current.rules = value; }} />
      </div>
      <div className="editor-pane" hidden={mode !== "skills"}>
        <SkillsEditor repo={repo} onChanged={onChanged} onDirty={(value) => { dirty.current.skills = value; }} />
      </div>
      <div className="editor-pane" hidden={mode !== "agents"}>
        <AgentsEditor repo={repo} onChanged={onChanged} onDirty={(value) => { dirty.current.agents = value; }} />
      </div>
    </section>
  );
}

function AgentsEditor({ repo, onChanged, onDirty }: { repo: string; onChanged: () => Promise<boolean>; onDirty: (dirty: boolean) => void }) {
  const [body, setBody] = useState("");
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = body !== baseline;

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  useEffect(() => {
    let cancelled = false;
    void window.flow.invoke("flow:agentsmd.read", { repo }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setBody(result.value.body);
      setBaseline(result.value.body);
    });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  async function save(): Promise<void> {
    if (!dirty) {
      setStatus("No changes to save.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.flow.invoke("flow:agentsmd.write", { repo, body });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setBody(result.value.body);
    setBaseline(result.value.body);
    const pending = await onChanged();
    setStatus(pending ? "Saved. It applies to the next message." : "Saved.");
  }

  return (
    <div className="shell">
      <div className="col">
        <h2>Project</h2>
        <div className="scroll">
          <button type="button" className="project" aria-current="true">
            <strong>AGENTS.md</strong>
            <small>Project instructions</small>
          </button>
        </div>
      </div>
      <div className="col">
        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void save();
          }}
        >
          <h2>AGENTS.md</h2>
          <p className="editor-note">A saved change applies to the next message.</p>
          <label htmlFor="agents-body">Body</label>
          <textarea
            id="agents-body"
            className="editor-body"
            rows={16}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          {error ? <p className="error">{error}</p> : null}
          {status ? <p className="meta">{status}</p> : null}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !dirty}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
