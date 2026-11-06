# Architecture

Mango is two processes. The Electron **main** process owns everything with authority: the API key, the workspace folder, the repo files, one agent per repo, and each repo's pending question. The **renderer** is a React view with no Node access. It sends validated commands and paints events. Main is the source of truth; the renderer holds nothing that cannot be rebuilt by asking main.

## Context

```mermaid
flowchart LR
    User((User)) --> UI
    subgraph App["Mango (Electron)"]
        UI["Renderer: React UI"] <-->|"typed IPC via preload"| Main["Main process"]
    end
    Main -->|"@cursor/sdk local"| Agent["Cursor agent (runs on this Mac)"]
    Main <-->|"read/write, allowlisted"| Files["Folder: .cursor/rules, .cursor/skills, AGENTS.md"]
    Main <--> UserData["userData: settings, chats, encrypted key, encrypted Jira token, encrypted GitHub tokens"]
    Main -->|"Basic auth, assigned tickets"| Jira["Jira Cloud (one atlassian.net site)"]
    Main -->|"Bearer token, read-only"| GitHub["api.github.com (pull requests, projects)"]
    Agent -->|"model calls"| Cursor["Cursor API (needs CURSOR_API_KEY)"]
    Agent -->|"shell, edit, read"| Folder["Chosen folder"]
```

"Local" means the agent runs on this Mac against the folder. The model is still served by Cursor, so a key is required. This is an assumption from the plan, not offline inference.

## Main-process modules

Main is built in one place, `src/main/index.ts` (the composition root). Each module is a factory that receives what it needs as arguments. A module does not import `electron` or another module's concrete instance, except `index.ts`, `window.ts`, and `ipc.ts`. This keeps modules testable with fakes and keeps the SDK in one file. `settings-store.ts`, `jira-service.ts`, and `github-service.ts` all call `writeAtomic` from `atomic-write.ts` (temp file, mode `0600`, then rename). None of them keeps its own copy.

```mermaid
flowchart TB
    Index["index.ts: composition root"] --> Window["window.ts: secure BrowserWindow"]
    Index --> Ipc["ipc.ts: register commands, sender check, parse"]
    Index --> Settings["settings-store.ts: settings, key, chat files"]
    Index --> Files["rules-skills-service.ts: allowlisted file access"]
    Index --> Jira["jira-service.ts: Jira token, assigned tickets"]
    Ipc --> Jira
    Index --> GitHub["github-service.ts: GitHub tokens, pull requests, projects"]
    Ipc --> GitHub
    Index --> Agent["agent-service.ts: only importer of @cursor/sdk"]
    Index --> Manager["session-manager.ts: one RepoSession per repo"]
    Ipc --> Manager
    Manager --> Session["chat-session.ts: one repo's state, run, question"]
    Ipc --> Files
    Session --> Agent
    Session --> Settings
    Session --> Files
    Session --> Prompt["prompt.ts: text of each send"]
    Session --> Events["event emitter: to the window"]
```

| Module | Owns | Never does |
|--------|------|------------|
| `window.ts` | Window and its security settings | Business logic |
| `ipc.ts` | Command registration, sender check, `input.parse`, result envelope | Call the SDK or touch files directly |
| `settings-store.ts` | `settings.json`, chat files, the encrypted key (via an injected `safeStorage`) | Return the key to the renderer |
| `rules-skills-service.ts` | Reading and writing rules, skills, `AGENTS.md` inside the allowlist | Touch any path outside it |
| `jira-service.ts` | `jira.bin` (encrypted email, site origin, API token), the ticket search, the browse URL | Import `electron` (it gets `safeStorage` and `openExternal` as arguments), return the token, call any host but the stored `https://<name>.atlassian.net` |
| `github-service.ts` | `github.bin` (two encrypted tokens, their logins, the picked repos and projects), the repo list, pull request and project requests, the item URL, the token-page table, the workspace checkout name for a picked repo (through a callback from `index.ts`), and whether `pr-reviews/<number>.md` is saved | Import `electron` (it gets `safeStorage` and `openExternal` as arguments), return a token, call any host but `https://api.github.com`, write to GitHub |
| `atomic-write.ts` | The temp-file write used by `settings-store.ts`, `jira-service.ts`, and `github-service.ts` | Open a file in place, or write a mode other than `0600` |
| `agent-service.ts` | `Agent.create`, `Agent.resume`, `send`, stream mapping, cancel, dispose | Know about IPC or the UI |
| `tool-summary.ts` | The one-line detail for a tool call: a repo-relative path, a command, or a pattern, taken from the call's arguments | Import the SDK or read the result of a call |
| `session-manager.ts` | The repo map, lazy `AgentService` per repo, global busy checks, shutdown | Call the SDK itself |
| `chat-session.ts` | One repo's state machine, current run, and pending question | Call Electron APIs |
| `prompt.ts` | The text of each send: project-wins line, ask-tool line, implement-plan line, pr-review line, optional transcript | Call the SDK, IPC, or the filesystem |

`chat-session.ts` is the one place that coordinates; the others are leaves. `ipc.ts` calls the session manager for settings, the key, the chat, and questions, and calls `rules-skills-service` for files. It does not call the settings store itself. `agent-service.ts` translates SDK messages into Mango's own event type (`delta`, `tool` with status `running`, `ok`, or `error`, `done`, `error`), so a beta SDK change stays inside that file (the sibling project's spikes S1 to S3 used SDK 1.2.0, which is pinned).

## Data ownership

| Data | Owner | Stored in | Seen by renderer |
|------|-------|-----------|------------------|
| Cursor API key | `settings-store` | `userData/secrets.bin`, encrypted with `safeStorage`, mode `0600` | Only "is set" |
| Jira email, site, API token | `jira-service` | `userData/jira.bin`, encrypted with `safeStorage`, mode `0600` | Email, site origin, and "token is set". Never the token |
| GitHub repos token, Projects token, logins, picked repos and projects | `github-service` | `userData/github.bin`, encrypted with `safeStorage`, mode `0600` | "Token is set" for each, the logins, and the picks. Never a token |
| Settings (folder, model, mode, theme) | `settings-store` | `userData/settings.json` | Yes. `mode` is `agent` (the default when the field is missing) or `plan`. Theme is `system` (the default), `light`, or `dark` |
| Chat messages and `agentId` | `settings-store` | `userData/chats/<repoId>.json` | Messages, yes; `agentId`, no |
| Rules, skills, `AGENTS.md` | `rules-skills-service` | The user's folder (`.cursor/`), shared with Cursor IDE | Yes, through commands |
| Current run and pending question | `chat-session` | Memory in main | Through events and `chat.state` |

`userData` is Electron's path for this app, `~/Library/Application Support/Mango`. On the first launch, if that directory is missing and `~/Library/Application Support/flowfe` exists, main renames the old directory to `Mango`. Clearing the key renames `secrets.bin` aside (`secrets.bin.<time>.cleared`) instead of deleting it in place. A settings or chat file that does not parse is renamed aside (`*.corrupt`) and the empty value is used.

`repoId` is a hash of the repo's real path. One repo has one chat. The workspace folder is `settings.folder`. Changing it disposes every session and switches to the new workspace's chats. It does not delete the old files.

## Patterns used

1. **Main as source of truth.** On start the renderer calls `settings.get`, `chat.history`, and `chat.state`, then subscribes to events. A reload loses nothing main still holds.
2. **Composition root with dependency injection.** Factories take their dependencies as arguments. A caller can pass a fake instead of Electron or the SDK. The repo has no unit-test suite yet; the checks are `npm run typecheck`, `npm run check:questions`, and `scripts/phase2-files-check.mjs`.
3. **Anti-corruption layer around the SDK.** Only `agent-service.ts` imports `@cursor/sdk`. Everything else sees Mango's own event type.
4. **Command catalog plus one event stream.** Requests use `invoke`; streaming uses one event channel. See [ipc-contract.md](ipc-contract.md).
5. **State machine for the chat.** One explicit state replaces scattered booleans. See [session-and-questions.md](session-and-questions.md).
6. **Correlation map for questions.** A pending-promise map keyed by question id bridges the agent's tool call and the user's form answer.
7. **Allowlist gateway for files.** All file access goes through `rules-skills-service`. It resolves real paths and allows only `<folder>/.cursor/rules`, `<folder>/.cursor/skills`, and `<folder>/AGENTS.md`.
8. **Snapshot on use.** Rules and skills are read when the agent is created. An edit applies to the next message by creating a new agent. A running run keeps what it started with. Resume is for a restart where the files did not change. Changing the model or the mode does not create a new agent: the next send passes the saved model and the current mode. A catalog id is sent as `{ id }`. A variant alias such as `claude-sonnet-5-5-high` is sent as that model's catalog id plus the variant's parameters. Changing the folder or the key disposes the current agent.
9. **Atomic JSON persistence with one writer.** Main serializes writes; each write goes to a temp file in the same directory, then renames over the target.

## Security boundaries

- Window: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. No remote URL; `window.open`, navigation, and webviews are refused; all permission requests are denied. These match the sibling project's window. This window also sets a minimum size and a background color.
- Diagrams: a `mermaid` block is drawn in the renderer with `securityLevel: "strict"` and shown through `<img>` with a data URL, so it cannot run script. The page CSP (`img-src 'self' data:`) is unchanged. The `mermaid` code is loaded from the app's own files with a dynamic import.
- Preload exposes only the command catalog and one event subscription. It exposes no raw `ipcRenderer`.
- Jira: every request is made in main, so the page CSP (`connect-src 'none'`) is unchanged. The API token is stored like the Cursor key and never appears in an IPC result, a log, or `settings.json`. Search and `shell.openExternal` use only the stored origin, and that origin must be `https://<name>.atlassian.net` with no port and no user info (D-16). The token is not scoped: it is a full account credential, and Mango only uses it to search and to open a browse URL.
- GitHub: every request is made in main, so the page CSP (`connect-src 'none'`) is unchanged. Both tokens are stored like the Cursor key and never appear in an IPC result, a log, or `settings.json`. Requests go only to `https://api.github.com`, and a `Link` page is followed only when it is on that origin (D-17). `shell.openExternal` receives only a URL from a fixed table (the two token pages) or `https://github.com/<owner>/<repo>/(pull|issues)/<n>`, built in main from a name that matches `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$` (not `.` or `..`) and a positive number. The window sends `{ kind }` or `{ repo, kind, number }`, never a URL. For a review the window sends `{ repo, number }` (`flow:github.openReview`, `flow:github.reviewReady`) or ordinary chat text through `flow:chat.send`, never a path. Main resolves the checkout and the file, and reads `Yes` or `No` from its `## Verdict` section. Mango still writes nothing to GitHub; the agent runs the `pr-review` skill, which does not post either. A classic `repo` token can write to GitHub; Mango only reads, and Setup says so.
- Every handler checks that the sender is the app's own window, then parses with the command's Zod `input`, then acts. Events are sent only to that window.
- The key never leaves main. It is not in logs, in IPC results, or in the agent's prompt. The SDK takes `apiKey` as an explicit option (checked in the 1.2.0 typings), and `agent-service.ts` always passes it. Without it the SDK falls back to `CURSOR_API_KEY` and then to a stored `Cursor.auth.login()` key, which could silently use a different account than the one the user entered.
- File allowlist: the folder is resolved with `realpath`. Allowed targets are `<folder>/.cursor/rules/*.mdc`, `<folder>/.cursor/skills/<name>/SKILL.md`, and `<folder>/AGENTS.md`. A name must match `^[a-z0-9][a-z0-9-_]{0,63}$` (1 to 64 characters). A file that is a symlink is refused. A directory symlink for `.cursor`, `rules`, or `skills` is followed only when its real path stays inside the folder. A skill folder that is itself a symlink is refused on read and delete. A path that resolves outside the folder is refused before any read or write.
- The agent runs shell and edit tools **without approval** in headless local mode (Mango spike S3). The setup screen says the agent can run shell commands and edit files without asking first. There is no read-only toggle in v1 (D-12). Plan mode is a conversation mode (D-13), not a tool lock. `settingSources: ["project", "user"]` loads the folder's own hooks, MCP servers, and skills, and the user layer. The app does not write `~/.cursor`. Each send starts with a line that a user-level instruction wins over a project one, a line that tells the agent to call `ask_user_question`, a line that says implementing a plan follows `~/.cursor/skills/implement-plan/SKILL.md`, and a line that says reviewing a pull request follows `~/.cursor/skills/pr-review/SKILL.md` (D-11). Under the folder button, setup says the agent may also see other instruction sources, because the Phase 0 log still loaded 23 skills from outside an empty folder.

## Renderer structure

No global state library. One reducer in `renderer/state.ts`. After load, the window shows one of these screens:

- **Setup**: key, folder, model, mode, and theme, until all of key, folder, and model exist. Chat can open it again; once setup is complete it has Back to chat.
- **Chat**: the reducer fed by `chat.history` plus the event stream. `segments.ts` turns the items into blocks: a run's text is cut at the `offset` of each tool call, question, and plan, so the thread reads text, a tool strip or card, text, and so on. A tool strip shows one row per call (name, path or command, status) and is four rows tall, with a scrollbar for more. A Task call is its own card (`SubagentCard.tsx`): the task description, the model, and while it runs the latest tool the subagent started, with the status Waiting for subagent. Text and finished plans render as markdown through `Markdown.tsx` (D-14). A `mermaid` fence is drawn as a diagram by `MermaidBlock.tsx` once its message has finished, and shown as code while it streams (D-15). A question card, the banner, a mode control, a model picker, the theme switch, Reset chat, and a Rules button are also in the screen. Reset chat asks for confirmation, then calls `chat.reset`. In a workspace with several repos that also returns to New chat.
- **Left menu** (`RepoSidebar.tsx`): shown when the workspace has more than one repo. It lists repos that are running, waiting, have history, have an unseen reply, have an error banner, or are the open chat. Remove asks for confirmation, then calls `chat.reset` for that repo. A running or waiting repo cannot be removed. When the removed repo is the one on screen, the window returns to New chat. Header Reset chat uses that same leave. A workspace with one repo has no left menu; Reset chat stays on the empty thread.
- **Jira tickets** (`JiraTickets.tsx`): a pane that replaces the chat, New chat, or Rules while `jiraOpen` is set. The flag is separate from `view`, so Back (`close-jira`) restores whatever was open, and `open-repo` or `open-home` also clear it. It lists the assigned, not-done issues of the one saved site, with Load more, Retry, and a not-set-up state that links to Setup. A row opens the issue in the system browser. The Jira button is under New chat in the left menu, or in the chat header when the workspace has one repo. Setup has a Jira section (`JiraSetup.tsx`) for the email, the site, and the API token. While the list is open no repo row looks selected.
- **GitHub Pull requests** (`GitHubPrs.tsx`) and **Projects** (`GitHubProjects.tsx`): two more panes that replace the chat, New chat, or Rules, with `githubPrsOpen` and `githubProjectsOpen`. At most one of `jiraOpen`, `githubPrsOpen`, and `githubProjectsOpen` is true: opening one clears the others, and `open-repo`, `open-home`, and `implement-ticket` clear all three. `screenOf` returns `"githubPrs"` or `"githubProjects"`. The Pull requests pane has one tab per picked repo (`role="tablist"`), loaded on first use and cached per repo, and each row opens the PR in the system browser. A card for a PR you have not approved has a **Review** button when `flow:github.prs` returned a `checkout` for that repo. The button calls `App.startReview`, which applies the same busy checks as New chat and then `sendRepo(checkout, "review pr <url>")`. The prompt is built by `reviewPrompt` from a name that passes `isRepoFullName`. The pane stays open. While `reviewPhase(slice, prompt)` is `running` (that repo's chat is `streaming` or `stopping` and its `lastUserText` is that prompt) the card shows a spinner, and while it is `asking` it shows **Answer in the chat**. The pane polls `flow:github.reviewReady` every 2 seconds while a review runs, and shows **Yes** or **No**, then **See review** (`flow:github.openReview`), as soon as the file exists and its `## Verdict` section says so. When a run ends without the file, the pane says so. The Projects pane is a copy of the Jira board (same classes, same three columns through `projectColumn`, same Implement and Load more), with a project switcher in the header when several projects are picked. A button for each shows in the left menu, or in the chat header when the workspace has one repo, only while its token is saved. Setup has a GitHub block (`GitHubSetup.tsx`): two token fields, each with Get token, a repo picker, and a project picker.
- **Rules and skills** (`Instructions.tsx`): tabs for rules, skills, and `AGENTS.md`. Rules and skills are a list on the left and a form on the right, with load / edit / save, a dirty flag, and the note that a saved change applies to the next message. `AGENTS.md` is one body field. Leaving the screen with unsaved edits asks for confirmation.

`QuestionForm` takes the question as props and calls back with an answer or a skip. It checks the answer with `shared/questions.ts` before that callback. It does not know about the SDK.

## Folder layout

```text
src/
  main/       index.ts, window.ts, ipc.ts, session-manager.ts, chat-session.ts,
              agent-service.ts, tool-summary.ts, prompt.ts,
              rules-skills-service.ts, settings-store.ts, atomic-write.ts, jira-service.ts,
              github-service.ts
  preload/    index.ts, bridge.ts
  shared/     ipc.ts, jira.ts, github.ts, questions.ts, mention.ts, plan-markdown.ts (exports isCreatePlan only),
              task.ts (exports isTask and mergeSubagent)
  renderer/   main.tsx, App.tsx, state.ts, segments.ts, Setup.tsx, Chat.tsx, NewChat.tsx,
              MentionComposer.tsx, RepoSidebar.tsx, QuestionForm.tsx, PlanCard.tsx,
              SubagentCard.tsx, ToolStrip.tsx, Markdown.tsx, markdown-config.ts, MermaidBlock.tsx,
              mermaid-config.ts, mermaid-render.ts, dark-mode.ts,
              Instructions.tsx, RulesEditor.tsx, SkillsEditor.tsx, JiraTickets.tsx,
              JiraSetup.tsx, GitHubPrs.tsx, GitHubProjects.tsx, GitHubSetup.tsx, Bot.tsx,
              global.d.ts, styles.css
docs/         this folder
scripts/      phase0-spike.ts, phase2-files-check.mjs, phase3-questions-check.ts,
              mention-check.ts, repos-check.ts, sidebar-check.ts, plan-check.ts,
              segments-check.ts, tool-summary-check.ts, jira-check.ts, github-check.ts,
              packaged-sdk-check.mjs, after-pack.cjs
```

`shared/` holds schemas, types, and question parsing: no I/O. `ipc.ts` is the command and event catalog. `questions.ts` is the ask-tool schema, answer checks, and the JSON returned to the agent. Main, preload, and renderer all import `shared/`.

## Packaging

An unsigned local `.app` via `electron-builder` (`dir` target, macOS arm64 only, `identity: null`). `npm run dist` writes `release/mac-arm64/Mango.app`. `@cursor/sdk-darwin-*` is listed in `asarUnpack` because the SDK locates `bin/rg`, `bin/cursorsandbox`, and `vendor/**/binding.node` by walking up from the main script and spawning those files; they cannot run from inside `app.asar`. `scripts/after-pack.cjs` sets the executable bit on those unpacked `bin` files. `scripts/packaged-sdk-check.mjs` checks the unpacked tree, loads the tree-sitter `.node` files with the packaged binary, runs `rg --version`, and requires the `.app` to stay up for a few seconds (that startup imports `@cursor/sdk`). A full agent turn inside the packaged app is not part of the check, because that needs a key and a folder.

## Out of scope

Windows and Linux, signing and auto-update, the cloud runtime, several chats per repo, an orchestrator, a database, and user-level `~/.cursor` editing. GitHub is read-only: no merging, reviewing, commenting, or moving cards, no org-owned projects, no GitHub Enterprise, and no GitHub tools for the agent. Jira is read-only and is one Cloud site: no creating or editing tickets, no comments, no Jira Server or Data Center, no OAuth, and no Jira tools for the agent. At most 7 repo agents run at once.
