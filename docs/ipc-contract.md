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
- No command returns the API key, the `agentId`, or a path outside the chosen folder.

## Commands

`registerIpc` handles every channel in `COMMANDS` in one loop. `pendingQuestion` is present on `flow:chat.state` while a form is waiting.

| Channel | Input | Output | Notes |
|---------|-------|--------|-------|
| `flow:settings.get` | none | `{ folder, model, mode, theme, keySet, folderMissing, setupComplete }` | `mode` is `agent` or `plan`. `theme` is `system`, `light`, or `dark`. `keySet` is a boolean. `folderMissing` is true when a folder path is saved and that path is no longer a directory |
| `flow:settings.save` | `{ folder?, model?, mode?, theme? }` | settings | Changing `folder` switches to that folder's chat. Changing `folder`, `model`, or `mode` is refused with `conflict` while any repo is busy |
| `flow:key.set` | `{ key }` | `{}` | `key` is trimmed, then 1 to 500 characters. Encrypts with `safeStorage`; never returned |
| `flow:key.clear` | none | `{}` | Renames `secrets.bin` aside. It does not return the key |
| `flow:folder.pick` | none | `{ folder: string \| null }` | Opens the native dialog in main; `null` on cancel |
| `flow:models.list` | none | `{ models: { id, label }[] }` | Needs the key |
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
| `chat.tool` | `{ toolCallId, name, status: "running" \| "ok" \| "error", summary, offset?, plan?, truncated? }` | A tool line; the same id updates its status. `summary` is one short line built from the call's arguments (a path relative to the repo, a command, or a search pattern); it is empty when the arguments have no known key. The `ask_user_question` call has no tool line, because its question card is shown instead. `offset` is the number of characters of the agent message that existed when this call first appeared; later events for the same id repeat it. The window uses it to show text, tool calls, and cards in the order they happened. `plan` is the `createPlan` markdown, at most 200000 characters. `truncated` is true when that text was cut |
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
