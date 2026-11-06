import { useEffect, useRef, useState } from "react";
import { INSTRUCTION_NAME, type Skill, type SkillSummary } from "../shared/ipc.js";
import { Confirm } from "./RulesEditor.js";

type Draft = { name: string; description: string; body: string };

const EMPTY: Draft = { name: "", description: "", body: "" };

type SkillsEditorProps = {
  repo: string;
  onChanged: () => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
};

export function SkillsEditor({ repo, onChanged, onDirty }: SkillsEditorProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
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
  }, [repo]);

  async function loadList(current: number): Promise<void> {
    const listed = await window.flow.invoke("flow:skills.list", { repo });
    if (current !== token.current) return;
    if (!listed.ok) {
      setError(listed.error.message);
      return;
    }
    setSkills(listed.value);
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

  async function openSkill(name: string): Promise<void> {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    const current = ++token.current;
    setBusy(true);
    const result = await window.flow.invoke("flow:skills.read", { repo, name });
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
    const result = await window.flow.invoke("flow:skills.write", {
      repo,
      name,
      description: draft.description,
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
    const result = await window.flow.invoke("flow:skills.delete", { repo, name: selected });
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

  const replaces = creating && skills.some((skill) => skill.name === draft.name.trim());

  return (
    <>
    <div className="shell">
      <div className="col">
        <h2>Skills</h2>
        <div className="scroll">
          {skills.length === 0 ? <p className="meta list-empty">No skills yet.</p> : null}
          {skills.map((skill) => (
            <button
              key={skill.name}
              type="button"
              className="project"
              aria-current={selected === skill.name && !creating}
              onClick={() => void openSkill(skill.name)}
            >
              <strong>{skill.name}</strong>
              <small>{skill.description || "No description"}</small>
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
            <h2>{creating ? "New skill" : draft.name}</h2>
            <p className="editor-note">A saved change applies to the next message.</p>
            <label htmlFor="skill-name">Name</label>
            <input
              id="skill-name"
              type="text"
              value={draft.name}
              readOnly={!creating}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <p className="meta">{creating ? "Lowercase letters, numbers, and hyphens." : fileHint(draft.name)}</p>
            {replaces ? <p className="warn">Saving replaces the existing skill.</p> : null}
            <label htmlFor="skill-description">Description</label>
            <input
              id="skill-description"
              type="text"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
            <label htmlFor="skill-body">SKILL.md</label>
            <textarea
              id="skill-body"
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
            <h2>Skills</h2>
            <p className="editor-note">A saved change applies to the next message.</p>
            {error ? <p className="error">{error}</p> : null}
            {status ? <p className="meta">{status}</p> : null}
            <p className="meta">Select a skill, or create one. Each skill is a .cursor/skills folder with a SKILL.md file.</p>
          </div>
        )}
      </div>
    </div>
    {confirming && selected !== null ? (
      <Confirm
        title={`Delete ${selected}?`}
        body="This removes the skill folder from the project."
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    ) : null}
    </>
  );
}

function toDraft(skill: Skill): Draft {
  return { name: skill.name, description: skill.description, body: skill.body };
}

function fileHint(name: string): string {
  return name === "" ? ".cursor/skills" : `.cursor/skills/${name}/SKILL.md`;
}
