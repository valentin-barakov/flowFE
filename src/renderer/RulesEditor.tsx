import { useEffect, useRef, useState } from "react";
import { INSTRUCTION_NAME, type Rule, type RuleSummary } from "../shared/ipc.js";

type Draft = {
  name: string;
  description: string;
  alwaysApply: boolean;
  globs: string;
  body: string;
};

const EMPTY: Draft = { name: "", description: "", alwaysApply: false, globs: "", body: "" };

type RulesEditorProps = {
  onChanged: () => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
};

export function RulesEditor({ onChanged, onDirty }: RulesEditorProps) {
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [baseline, setBaseline] = useState(JSON.stringify(EMPTY));
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const token = useRef(0);
  const dirty = JSON.stringify(draft) !== baseline;
  const open = creating || selected !== null;

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  useEffect(() => {
    const current = ++token.current;
    void loadList(current);
  }, []);

  async function loadList(current: number): Promise<RuleSummary[] | null> {
    const listed = await window.flow.invoke("flow:rules.list", {});
    if (current !== token.current) return null;
    if (!listed.ok) {
      setError(listed.error.message);
      return null;
    }
    setRules(listed.value);
    return listed.value;
  }

  function adopt(next: Draft, name: string | null, isNew: boolean): void {
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setSelected(name);
    setCreating(isNew);
    setError(null);
    setStatus(null);
    setConfirming(false);
  }

  function startNew(): void {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    token.current += 1;
    adopt(EMPTY, null, true);
  }

  async function openRule(name: string): Promise<void> {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    const current = ++token.current;
    setBusy(true);
    const result = await window.flow.invoke("flow:rules.read", { name });
    setBusy(false);
    if (current !== token.current) return;
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    adopt(toDraft(result.value), result.value.name, false);
  }

  async function save(): Promise<void> {
    const name = draft.name.trim();
    if (!INSTRUCTION_NAME.test(name)) {
      setError("Use a lowercase name: letters, numbers, and hyphens.");
      return;
    }
    if (!dirty) {
      setStatus("No changes to save.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.flow.invoke("flow:rules.write", {
      name,
      description: draft.description,
      alwaysApply: draft.alwaysApply,
      globs: draft.globs,
      body: draft.body,
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.error.message);
      return;
    }
    const current = ++token.current;
    await loadList(current);
    setBusy(false);
    if (current !== token.current) return;
    adopt(toDraft(result.value), result.value.name, false);
    const pending = await onChanged();
    setStatus(pending ? "Saved. It applies to the next message." : "Saved.");
  }

  async function remove(): Promise<void> {
    if (selected === null) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    const result = await window.flow.invoke("flow:rules.delete", { name: selected });
    if (!result.ok) {
      setBusy(false);
      setError(result.error.message);
      return;
    }
    const current = ++token.current;
    await loadList(current);
    setBusy(false);
    if (current !== token.current) return;
    adopt(EMPTY, null, false);
    const pending = await onChanged();
    setStatus(pending ? "Deleted. It applies to the next message." : "Deleted.");
  }

  const replaces = creating && rules.some((rule) => rule.name === draft.name.trim());

  return (
    <>
    <div className="shell">
      <div className="col">
        <h2>Rules</h2>
        <div className="scroll">
          {rules.length === 0 ? <p className="meta list-empty">No rules yet.</p> : null}
          {rules.map((rule) => (
            <button
              key={rule.name}
              type="button"
              className="project"
              aria-current={selected === rule.name && !creating}
              onClick={() => void openRule(rule.name)}
            >
              <strong>{rule.name}</strong>
              <small>{rule.alwaysApply ? "Always applies" : rule.description || "No description"}</small>
            </button>
          ))}
        </div>
        <div className="side-actions">
          <button type="button" className="btn" onClick={startNew}>
            New
          </button>
        </div>
      </div>
      <div className="col">
        {open ? (
          <form
            className="editor-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void save();
            }}
          >
            <h2>{creating ? "New rule" : draft.name}</h2>
            <p className="editor-note">A saved change applies to the next message.</p>
            <label htmlFor="rule-name">Name</label>
            <input
              id="rule-name"
              type="text"
              value={draft.name}
              readOnly={!creating}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <p className="meta">{creating ? "Lowercase letters, numbers, and hyphens." : fileHint(draft.name)}</p>
            {replaces ? <p className="warn">Saving replaces the existing rule.</p> : null}
            <label htmlFor="rule-description">Description</label>
            <input
              id="rule-description"
              type="text"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
            <label className="check" htmlFor="rule-always">
              <input
                id="rule-always"
                type="checkbox"
                checked={draft.alwaysApply}
                onChange={(event) => setDraft({ ...draft, alwaysApply: event.target.checked })}
              />
              Always apply
            </label>
            <label htmlFor="rule-globs">Globs</label>
            <input
              id="rule-globs"
              type="text"
              value={draft.globs}
              placeholder="Optional, for example **/*.ts"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, globs: event.target.value })}
            />
            <label htmlFor="rule-body">Body</label>
            <textarea
              id="rule-body"
              className="editor-body"
              rows={14}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
            {error ? <p className="error">{error}</p> : null}
            {status ? <p className="meta">{status}</p> : null}
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy || !dirty}>
                Save
              </button>
              {selected !== null && !creating ? (
                <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirming(true)}>
                  Delete
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="editor-form">
            <h2>Rules</h2>
            <p className="editor-note">A saved change applies to the next message.</p>
            {error ? <p className="error">{error}</p> : null}
            {status ? <p className="meta">{status}</p> : null}
            <p className="meta">Select a rule, or create one. Files are stored in .cursor/rules.</p>
          </div>
        )}
      </div>
    </div>
    {confirming && selected !== null ? (
      <Confirm
        title={`Delete ${selected}?`}
        body="This removes the rule file from the project folder."
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    ) : null}
    </>
  );
}

function toDraft(rule: Rule): Draft {
  return {
    name: rule.name,
    description: rule.description,
    alwaysApply: rule.alwaysApply,
    globs: rule.globs,
    body: rule.body,
  };
}

function fileHint(name: string): string {
  return name === "" ? ".cursor/rules" : `.cursor/rules/${name}.mdc`;
}

export function Confirm({
  title,
  body,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-back" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{body}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
