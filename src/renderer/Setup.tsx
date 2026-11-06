import { useState } from "react";
import type { AgentMode, Settings, Theme } from "../shared/ipc.js";
import { Bot } from "./Bot.js";
import type { ModelChoice } from "./state.js";

type SetupProps = {
  settings: Settings;
  models: ModelChoice[];
  modelsError: string | null;
  pending: boolean;
  repos: { name: string }[];
  locked: boolean;
  onSaveKey: (key: string) => Promise<boolean>;
  onClearKey: () => Promise<void>;
  onPickFolder: () => Promise<void>;
  onModel: (model: string) => Promise<boolean>;
  onTheme: (theme: Theme) => void;
  onMode: (mode: AgentMode) => void;
  onBack: (() => void) | null;
};

export function Setup({ settings, models, modelsError, pending, repos, locked, onSaveKey, onClearKey, onPickFolder, onModel, onTheme, onMode, onBack }: SetupProps) {
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const showKeyField = !settings.keySet || replacing;
  const choices = modelChoices(models, settings.model);

  async function saveKey(): Promise<void> {
    const ok = await onSaveKey(key);
    if (!ok) return;
    setKey("");
    setReplacing(false);
  }

  return (
    <div className="setup">
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (showKeyField && key.trim() !== "") void saveKey();
        }}
      >
        <div className="setup-head">
          <Bot kind="agent" large />
          <div className="setup-title-row">
            <h2>Set up Mango</h2>
            <ThemeSwitch theme={settings.theme} onTheme={onTheme} />
          </div>
          <p className="lead">The key stays on this Mac. The app shows that it is set, and never the key itself.</p>
        </div>

        <section className="setup-field">
          <label htmlFor="cursor-key">Cursor key</label>
          {showKeyField ? (
            <div className="secret">
              <input
                id="cursor-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={settings.keySet ? "Paste a new key" : "Paste your Cursor API key"}
                onChange={(event) => setKey(event.target.value)}
              />
              <button type="button" className="btn primary" disabled={pending || locked || key.trim() === ""} onClick={() => void saveKey()}>
                Save key
              </button>
              {settings.keySet ? (
                <button type="button" className="btn" disabled={pending || locked} onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
          ) : (
            <div className="secret">
              <span className="key-state">Key saved</span>
              <button type="button" className="btn" disabled={pending || locked} onClick={() => setReplacing(true)}>
                Replace
              </button>
              <button type="button" className="btn danger" disabled={pending || locked} onClick={() => void onClearKey()}>
                Remove
              </button>
            </div>
          )}
        </section>

        <section className="setup-field">
          <label>Workspace folder</label>
          <div className="secret">
            <button type="button" className="btn" disabled={pending || locked} onClick={() => void onPickFolder()}>
              Choose folder
            </button>
            <span className="path" title={settings.folder ?? undefined}>
              {settings.folder ?? "No folder yet"}
            </span>
          </div>
          {repos.length > 0 ? (
            <p className="meta">{repos.map((repo) => (repo.name === "." ? "This folder" : repo.name)).join(", ")}</p>
          ) : null}
          <div className="setup-notes">
            <p>The agent can run shell commands and edit files in these repos without asking you first.</p>
            <p>Rules and skills from the repo you message are loaded. The agent may also see other instruction sources.</p>
          </div>
        </section>

        <section className="setup-field">
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={settings.model ?? ""}
            disabled={pending || locked || !settings.keySet || choices.length === 0}
            onChange={(event) => {
              const model = event.target.value;
              if (model !== "") void onModel(model);
            }}
          >
            <option value="">{settings.keySet ? "Choose a model" : "Save the key first"}</option>
            {choices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          {modelsError ? <p className="error">{modelsError}</p> : null}
        </section>

        <section className="setup-field">
          <label>Mode</label>
          <ModeSwitch mode={settings.mode} disabled={pending || locked} onMode={onMode} />
        </section>

        {onBack ? (
          <p className="actions">
            <button type="button" className="btn" onClick={onBack}>
              Back to chat
            </button>
          </p>
        ) : null}
      </form>
    </div>
  );
}

export function modelChoices(models: ModelChoice[], selected: string | null): ModelChoice[] {
  if (selected === null || models.some((model) => model.id === selected)) return models;
  return [{ id: selected, label: selected }, ...models];
}

const MODE_CHOICES = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
] as const;

export function ModeSwitch({ mode, disabled, onMode }: { mode: AgentMode; disabled: boolean; onMode: (mode: AgentMode) => void }) {
  return (
    <span className="agent-mode" role="group" aria-label="Mode">
      {MODE_CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          disabled={disabled}
          aria-pressed={mode === choice.id}
          onClick={() => {
            if (choice.id !== mode) onMode(choice.id);
          }}
        >
          {choice.label}
        </button>
      ))}
    </span>
  );
}

const THEME_CHOICES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export function ThemeSwitch({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <span className="theme-switch" role="group" aria-label="Theme">
      {THEME_CHOICES.map((choice) => (
        <button
          key={choice.id}
          type="button"
          title={choice.label}
          aria-label={choice.label}
          aria-current={theme === choice.id ? "true" : undefined}
          onClick={() => onTheme(choice.id)}
        >
          <ThemeIcon theme={choice.id} />
        </button>
      ))}
    </span>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.6" />
        <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.4 2.1a5.2 5.2 0 1 0 4.5 7.6A4.4 4.4 0 0 1 9.4 2.1z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.4" width="12" height="8.2" rx="1.2" />
      <path d="M6 13.6h4M8 10.6v3" />
    </svg>
  );
}
