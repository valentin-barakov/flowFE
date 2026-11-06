# IPC contract

The window and the main process talk through two mechanisms: **commands** (request and response, `ipcRenderer.invoke`) and **events** (main to renderer, one channel). The preload exposes exactly these and nothing else. Command and event schemas live in `src/shared/ipc.ts`. Question and answer schemas live in `src/shared/questions.ts` and are re-exported from `ipc.ts`. Those files are the definition for main, preload, and renderer.

## Rules

- Channel names are `flow:<area>.<action>` for commands and `flow:event` for events.
- Every command has an `input` and an `output` schema. Main checks the sender, then runs `input.parse`, then acts. A parse failure returns `invalid_input`; it does not throw into the renderer.
- Every command returns an envelope, so the renderer never handles a thrown IPC error:

```typescript
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };

type ErrorCode =
  | "not_allowed"      // wrong sender, or a path outside the allowlist
  | "invalid_input"    // Zod parse failed
  | "not_ready"        // setup incomplete, or the wrong chat state for this command
  | "not_found"
  | "conflict"         // a run is already in flight
  | "auth"             // key missing, rejected, or expired
  | "agent_error"      // the SDK failed; message is safe to show
  | "io_error";
```

- `chat.send` returns once the run has started. That includes opening or resuming the agent, which can take up to 10 seconds. It does not stay open for the whole answer, so Stop still works. The returned ids are the user message and the agent message for this run. The window holds events that arrive before the result, then paints them.
- The `flow:chat.state` command omits `runId` when no run is active. While a run is active, that command and the events use that run's id. A `chat.state` event uses `runId` `"session"` when nothing is running.
- The renderer applies every `chat.state` event. It ignores any other event for a run that `chat.done` or `chat.error` already sealed, and any event whose `runId` differs from the run that is currently active.
- Commands that touch a chat, a question, rules, skills, or `AGENTS.md` take `repo`. `repo` is `.` when the workspace folder is the only repo, otherwise a direct child directory name. Main resolves it against the scanned repo list. An unknown name returns `not_found`. No command returns a repo path.
- No command returns the API key, the `agentId`, the Jira API token, a GitHub token, or a path outside the chosen folder. `flow:jira.status` and `flow:jira.save` return the email, the site origin, and `tokenSet`. Every `flow:github.*` status carries `tokenSet`, the login, and the picks for each token, never the token.
- A Jira or GitHub failure uses the same `ErrorCode` values. The window shows it inside that pane or Setup, not in the Cursor key banner.

## Commands

`registerIpc` handles every channel in `COMMANDS` in one loop. `pendingQuestion` is present on `flow:chat.state` while a form is waiting.

| Channel | Input | Output | Notes |
|---------|-------|--------|-------|
| `flow:settings.get` | none | `{ folder, model, mode, theme, keySet, folderMissing, setupComplete }` | `mode` is `agent` or `plan`. `theme` is `system`, `light`, or `dark`. `keySet` is a boolean. `folderMissing` is true when a folder path is saved and that path is no longer a directory |
| `flow:settings.save` | `{ folder?, model?, mode?, theme? }` | settings | Changing `folder` switches to that folder's chat. Changing `folder`, `model`, or `mode` is refused with `conflict` while any repo is busy |
| `flow:key.set` | `{ key }` | `{}` | `key` is trimmed, then 1 to 500 characters. Encrypts with `safeStorage`; never returned |
| `flow:key.clear` | none | `{}` | Renames `secrets.bin` aside. It does not return the key |
| `flow:folder.pick` | none | `{ folder: string \| null }` | Opens the native dialog in main; `null` on cancel |
| `flow:models.list` | none | `{ models: { id, label }[] }` | Needs the key. Each catalog id is listed. A variant with one parameter value is also listed as `<id>-<value>`, and a saved alias of that shape is sent to the SDK as the catalog id plus that variant's parameters |
| `flow:repos.list` | none | `{ repos: { name, state, pendingQuestion, hasHistory }[] }` | `hasHistory` is true when that repo's chat file has any message. `pendingQuestion` is true while a form is open in that repo |
| `flow:chat.send` | `{ repo, text }` | `{ runId, userMessageId, agentMessageId, restored }` | `text` is trimmed, then 1 to 50 000 characters. `not_ready` when setup is incomplete. `conflict` when that repo is not `ready`, and also when 7 other repos are busy, with the message "Seven agents are already running. Stop one before starting another." `not_found` when the repo name is unknown. Returns once the run has started. `restored` is true when resume failed and the prompt included the last 20 text messages, each clipped to 8 000 characters. A rules or skills edit also seeds that transcript, and leaves `restored` false |
| `flow:chat.stop` | `{ repo }` | `{}` | Cancels the run and rejects a pending question |
| `flow:chat.history` | `{ repo }` | `{ messages: Message[] }` | |
| `flow:chat.state` | `{ repo }` | `{ state, runId?, instructionsPending, pendingQuestion? }` | Called on renderer start to resume the view. `runId` is omitted when no run is active. `instructionsPending` is true after a rules, skills, or `AGENTS.md` save until the next send creates a new agent. `pendingQuestion` is `{ questionId, title?, questions }` while a form is open. It is omitted otherwise. A window reload reads it and shows the same form |
| `flow:chat.reset` | `{ repo }` | `{}` | Reset chat: drops `agentId` and messages for this repo |
| `flow:question.answer` | `{ repo, questionId, answers }` | `{}` | `answers` as below |
| `flow:question.skip` | `{ repo, questionId }` | `{}` | |
| `flow:rules.list` | `{ repo }` | `RuleSummary[]` | `{ name, description, alwaysApply }` |
| `flow:rules.read` | `{ repo, name }` | `Rule` | |
| `flow:rules.write` | `{ repo, name, description, alwaysApply, globs, body }` | `Rule` | Creates or overwrites. The New button uses this. An identical file does not set `instructionsPending` |
| `flow:rules.delete` | `{ repo, name }` | `{}` | The UI confirms first |
| `flow:skills.list` | `{ repo }` | `SkillSummary[]` | `{ name, description }` |
| `flow:skills.read` | `{ repo, name }` | `Skill` | |
| `flow:skills.write` | `{ repo, name, description, body }` | `Skill` | Creates or overwrites `.cursor/skills/<name>/SKILL.md` |
| `flow:skills.delete` | `{ repo, name }` | `{}` | Removes the skill folder. The UI confirms first |
| `flow:jira.status` | none | `{ email, site, tokenSet }` | `email` and `site` are null until saved. `site` is an origin such as `https://acme.atlassian.net`. `tokenSet` is a boolean. The token is never returned |
| `flow:jira.save` | `{ email, site, token? }` | status | `email` is trimmed, 3 to 200 characters, and must contain `@`. `site` is trimmed, 1 to 200 characters, then checked: `https`, host `<name>.atlassian.net`, no port, no user info. A path is dropped. `token`, when present, is trimmed, then 1 to 500 characters. Omitted `token` keeps the stored one. `not_ready` when no token is stored and none was sent. `invalid_input` for a bad site. `io_error` when this Mac cannot encrypt |
| `flow:jira.clear` | none | status | Writes an empty record over `jira.bin`. Email, site, and token are gone |
| `flow:jira.issues` | `{ pageToken? }` | `{ issues: { key, summary, status, type, project, updated }[], nextPageToken? }` | Issues assigned to the account whose status category is not Done, newest update first, 50 per page. `pageToken` is Jira's opaque `nextPageToken`, sent back only to turn the page. `not_ready` when email, site, or token is missing. `auth` on HTTP 401 or 403, and the saved token is kept. `not_found` on HTTP 404 |
| `flow:jira.open` | `{ key }` | `{}` | `key` must match `^[A-Z][A-Z0-9_]{1,49}-[0-9]{1,9}$`. Main opens `https://<site>.atlassian.net/browse/<key>` in the system browser. The window cannot pass a URL |
| `flow:github.status` | none | `{ repos: { tokenSet, login, selected }, projects: { tokenSet, login, selected } }` | `selected` for repos is `string[]` of `owner/name`. For projects it is `{ id, title }[]`. `login` is null until the token is saved. A token is never returned |
| `flow:github.saveRepoToken` | `{ token }` | status | `token` is trimmed, then 1 to 500 characters. Main checks it with `GET /user` first. `auth` on HTTP 401, or on 403 that is not a rate limit, and nothing is saved. `io_error` when this Mac cannot encrypt. Keeps the picked repos |
| `flow:github.clearRepoToken` | none | status | Removes the repos token, its login, and the picked repos |
| `flow:github.saveProjectToken` | `{ token }` | status | Same input as `saveRepoToken`. Main checks it with a GraphQL `viewer { login }` query |
| `flow:github.clearProjectToken` | none | status | Removes the Projects token, its login, and the picked projects |
| `flow:github.repos` | none | `{ repos: { fullName, private, archived }[], truncated }` | `GET /user/repos`, 100 per page, at most 10 pages, `Link` followed only on `api.github.com`. `truncated` is true when more pages remain. `not_ready` without the repos token |
| `flow:github.selectRepos` | `{ repos }` | status | `repos` is at most 30 names matching `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`, with the name part not `.` or `..`. Duplicates are dropped. `not_ready` without the repos token |
| `flow:github.prs` | `{ repo }` | `{ prs: { number, title, author, headRefName, baseRefName, isDraft, updatedAt, review, approvedByYou, ci, hasReview, verdict }[], total, checkout }` | One GraphQL call: the 50 most recently updated open pull requests of a picked repo. `review` is `approved`, `changes`, `required`, or null. `approvedByYou` is true when the signed-in user's latest review is an approval. `ci` is `passing`, `failing`, `pending`, or null. `hasReview` is true when the local checkout has `pr-reviews/<number>.md`. `verdict` is `yes` or `no` when that file's first lines have a `## Verdict` section whose next word is `Yes` or `No`, and null otherwise. `checkout` is the workspace repo name (`.` or a child folder) whose `origin` is this repo, or null when the workspace has no such checkout; it is the `repo` the window passes to `flow:chat.send` for a Review. `invalid_input` for a repo that is not picked. `not_found` when the token cannot see the repo. `auth` for a rejected token or a missing scope |
| `flow:github.projects` | none | `{ projects: { id, title }[] }` | The open personal projects of the signed-in user (`viewer.projectsV2`, first 50). `not_ready` without the Projects token |
| `flow:github.selectProjects` | `{ projects }` | status | At most 10 `{ id, title }`. `id` must match `^PVT_[A-Za-z0-9_-]+$`. `not_ready` without the Projects token |
| `flow:github.projectItems` | `{ projectId, cursor? }` | `{ items: { id, kind, repo, number, title, status }[], nextCursor? }` | Items of a picked project. Closed or merged issues and pull requests, and items whose Status is done, closed, completed, or shipped, are dropped. Drafts are kept (`kind` `draft`, `repo` and `number` null). Main reads up to 4 pages of 50, until 25 items are kept. `cursor` is GitHub's opaque `endCursor`, sent back only to turn the page. `invalid_input` for a project that is not picked. `not_found` when GitHub has no such project for the token |
| `flow:github.open` | `{ repo, kind, number }` | `{}` | `kind` is `pr` or `issue`. Main opens `https://github.com/<repo>/pull/<n>` or `/issues/<n>` in the system browser. `not_ready` when no GitHub token is saved. The window cannot pass a URL |
| `flow:github.openReview` | `{ repo, number }` | `{}` | Main opens the checkout's `pr-reviews/<number>.md` with the system app. The file must be a regular file inside the checkout (a symlink that leaves it is refused). `invalid_input` for a repo that is not picked. `not_found` when there is no saved review. The window cannot pass a path |
| `flow:github.reviewReady` | `{ repo, number }` | `{ ready, verdict }` | `ready` is true when `pr-reviews/<number>.md` is saved in the checkout, by the same check as `hasReview`. `verdict` is `yes`, `no`, or null from the `## Verdict` line at the start of that file. It reads the disk only and makes no GitHub request, so the card can poll it every 2 seconds while a review runs. `invalid_input` for a repo that is not picked |
| `flow:github.openTokenPage` | `{ kind }` | `{}` | `kind` is `repos` or `projects`. Main opens a fixed GitHub "new token" URL with the scope (`repo` or `read:project`) and a note filled in. Works before any token is saved. The window cannot pass a URL |

`AGENTS.md` is not a rule or a skill. `flow:agentsmd.read` takes `{ repo }` and returns `{ body }`. `flow:agentsmd.write` takes `{ repo, body }` of at most 200 000 characters and returns `{ body }`. An empty body writes an empty file.

### Question answers

```typescript
type Answers = Record<string /* questionId */, { selected: string[] /* optionIds */; other?: string }>;
```

`other` is set when the user types into the "Other" field; `selected` may then be empty.

## Events

All events arrive on `flow:event` with a `type` discriminator and a `runId`. Every event includes `repo` as well as `runId`. The preload drops a payload that does not match `EventSchema`. The renderer applies an event to that repo's slice, and still drops a non-`chat.state` event whose `runId` is not that slice's active run.

| `type` | Payload | Meaning |
|--------|---------|---------|
| `chat.state` | `{ state }` | The state machine changed |
| `chat.delta` | `{ messageId, text }` | Append `text` to the agent message |
| `chat.tool` | `{ toolCallId, name, status: "running" \| "ok" \| "error", summary, offset?, plan?, truncated?, subagent? }` | A tool line; the same id updates its status. `summary` is one short line built from the call's arguments (a path relative to the repo, a command, or a search pattern); it is empty when the arguments have no known key. The `ask_user_question` call has no tool line, because its question card is shown instead. A `task` call is drawn as a subagent card. `subagent` carries `description` (at most 200 characters), `model`, and `activity` (the latest nested tool, at most 160 characters). An activity update may repeat the same id with only `activity` set; the window keeps the description it already has. `offset` is the number of characters of the agent message that existed when this call first appeared; later events for the same id repeat it. The window uses it to show text, tool calls, and cards in the order they happened. `plan` is the `createPlan` markdown, at most 200000 characters. `truncated` is true when that text was cut |
| `chat.done` | `{ messageId, stopReason: "end" \| "stopped" }` | The run finished |
| `chat.error` | `{ code, message, retryable }` | The run failed. The state returns to `ready`, or to `needsSetup` when setup is no longer complete |
| `question.asked` | `{ questionId, title?, questions: Question[], offset? }` | Show the form. `offset` is the number of characters of the agent message that existed when the question was asked, so the form sits under the text written before it |
| `question.closed` | `{ questionId, reason: "answered" \| "skipped" \| "cancelled" }` | Disable the form |

```typescript
type Question = {
  id: string; // 1 to 80 characters
  prompt: string; // 1 to 2 000 characters
  options: { id: string; label: string }[]; // 1 to 20 options; each label is 1 to 500 characters
  allow_multiple?: boolean;
};
```

A tool call has 1 to 8 questions. `title`, when present, is 1 to 200 characters. Duplicate question ids, or duplicate option ids inside one question, are rejected before a form is shown. The tool then gets an error result and the chat stays in `streaming`.

## Domain types

A rule or skill name is one path segment matching `^[a-z0-9][a-z0-9-_]{0,63}$`. Description is at most 4 000 characters, globs at most 1 000, and a body at most 200 000. A name that fails the pattern returns `invalid_input`, because the command schema rejects it before the file service runs. A file that is a symlink returns `not_allowed`. A directory symlink for `.cursor`, `rules`, or `skills` is followed when its real path stays inside the folder, and returns `not_allowed` when it does not. A skill folder that is itself a symlink returns `not_allowed` on read and delete. A path that resolves outside the folder returns `not_allowed`.

```typescript
type RuleSummary = { name: string; description: string; alwaysApply: boolean };
type Rule = RuleSummary & { globs: string; body: string };
type SkillSummary = { name: string; description: string };
type Skill = SkillSummary & { body: string };

type Message =
  | { id: string; role: "user"; text: string; at: string }
  | { id: string; role: "agent"; text: string; at: string; status: "done" | "stopped" | "interrupted" | "error" }
  | { id: string; role: "tool"; name: string; summary: string; status: "ok" | "error"; at: string; offset?: number; plan?: string; truncated?: boolean }
  | { id: string; role: "question"; questionId: string; title?: string; questions: Question[]; answers: Answers | null; skipped: boolean; at: string; offset?: number };
```

An agent message with `status: "interrupted"` is one that was streaming when the app quit or crashed; see [session-and-questions.md](session-and-questions.md).

## Preload surface

```typescript
window.flow = {
  invoke: <C extends CommandChannel>(channel: C, input: Input<C>) => Promise<Result<Output<C>>>,
  onEvent: (listener: (event: FlowEvent) => void) => () => void, // returns unsubscribe
};
```

`invoke` rejects any channel not in the catalog before it reaches `ipcRenderer`. `onEvent` registers one listener on `flow:event`, parses the payload with `EventSchema`, and never exposes the raw event object. A payload that fails the schema is dropped.
