# Decisions and open questions

Each decision has an ID, the reason, and the rejected alternatives. Status is **accepted** (taken from the plan or from measured evidence), **provisional** (the Phase 0 spike decides), or **open**.

## Decisions

### D-1: Electron main owns all authority; the renderer is a view (accepted)

The key, folder, files, agent, and pending question live in main. The renderer sends validated commands and paints events.
**Reason:** the renderer has no need for secrets or Node, and a reload must not lose state.
**Rejected:** SDK in the renderer (exposes the key and Node); a local HTTP server (adds a port and an auth problem for no benefit).

### D-2: `@cursor/sdk` 1.2.0, local runtime, behind one file (accepted)

Pinned exactly. Only `agent-service.ts` imports it.
**Reason:** Mango spikes S1 to S3 and S22 ran it in Electron's main process on 1.2.0; the SDK is a public beta, so the blast radius of a change must be one file.
**Rejected:** the cloud runtime (out of scope, needs a different plan); the Cursor CLI headless (not spiked, output parsing).

### D-3: Rules and skills are the folder's own files (accepted)

The app edits `<folder>/.cursor/rules/*.mdc`, `<folder>/.cursor/skills/*/SKILL.md`, and `AGENTS.md` directly, so Cursor IDE sees the same ones.
**Reason:** `settingSources: ["project"]` loads the folder's rules (Mango spike S3 for hooks; Phase 0 spike for a rule and a skill). One copy avoids sync bugs. The Phase 0 log also loaded 23 skills that were not in the temp folder, so the project folder is not the only skill source the SDK reads.
**Rejected:** a copy in `userData` synced to the folder (two sources of truth); user-level `~/.cursor` (would change the user's other projects; out of scope).

### D-4: Question mechanism: custom tool `ask_user_question` (accepted)

A custom tool with Cursor's AskQuestion schema. Its `execute` awaits the form answer.
**Reason:** The Phase 0 spike on 2026-11-05 told an agent with no custom tool to call native `askQuestion`. The run finished, the stream had no such tool call, and the reply was `NO_ASK_TOOL`. The same day, `ask_user_question` was called, its arguments parsed, it waited 5001 ms, and the reply contained the token it returned. SDK 1.2.0 also has no public callback for the native tool.
**Rejected:** native `askQuestion` (the spike showed it is not callable headless); parsing questions out of the assistant's text (fragile, no blocking); a second chat turn as the answer (the form would not be tied to the run).
**Still open:** a wait of several minutes was not measured. The 5 second wait was.

### D-5: One chat per folder (accepted)

The chat file is `chats/<folderId>.json`. "New chat" drops the `agentId` and messages.
**Reason:** Valentin chose this on 2026-11-05. It is the smallest model that matches "run an agent in a folder".
**Rejected:** several chats per folder (needs a list UI and a separate `agentId` for each).

### D-6: Persistence is JSON files with atomic writes, no database (accepted)

`settings.json`, `chats/<folderId>.json`, and `secrets.bin` in `userData`. One writer in main; temp file plus rename.
**Reason:** one conversation per folder and a small message list. A database adds a dependency and a native build for no query need.
**Rejected:** SQLite (out of scope in the plan); `localStorage` in the renderer (renderer must hold no state main needs).

### D-7: Restart never assumes `Agent.resume` works (accepted, from evidence)

Messages are stored by Mango. On a failed or slow resume, create a new agent seeded with a transcript of recent messages.
**Reason:** Mango spike S8: after a kill mid-run, `Agent.resume` failed with "already has active run". Valentin chose the seed size on 2026-11-05: the last 20 messages, user and agent text only. The prompt clips each of those messages to 8 000 characters.
**Rejected:** trusting `agentId` alone (breaks after any crash); blocking the chat until resume succeeds (a stuck agent would lock the user out); seeding 10 or 50 messages.

### D-8: Edits to rules and skills apply to the next message (accepted)

**Reason:** a running run cannot pick up a file saved underneath it. The Phase 0 spike changed the rule from `ANCHOR` to `BEACON` before `Agent.resume`. The reply still ended with `ANCHOR`. A saved edit therefore starts a new agent on the next message, seeded from the stored transcript. Resume is kept for a restart where the files did not change.
**Rejected:** resuming after an edit (measured: the old rule stayed in force); hot reload (no SDK support known).

### D-9: Commands return a `Result` envelope, not thrown errors (accepted)

**Reason:** the renderer handles one shape; a thrown error across `invoke` loses its code.
**Rejected:** throwing in handlers (error codes get wrapped in a generic IPC message).

### D-10: No renderer state library; a reducer per screen (accepted)

**Reason:** the state is small, main is the source of truth, and the chat is an event-fed reducer.
**Rejected:** Redux, Zustand, or a data-fetching library (extra dependencies for three screens).

### D-11: User-level rules are overridden, not edited (accepted)

The app never writes `~/.cursor`. The agent is created with `settingSources: ["project"]`, so the user layer is not requested. Each send starts with that override line, then a second line that tells the agent to call `ask_user_question`. Both lines are part of the prompt `prompt.ts` builds. They are not written into `~/.cursor` or the project.
**Reason:** Valentin, 2026-11-05. Editing `~/.cursor` would change his other Cursor projects. He still wants this agent's run to prefer the project.
**Rejected:** editing `~/.cursor` from the app; leaving user rules in force with no override.
**Still open:** the Phase 0 log loaded 23 skills that were not in the temp folder. `settingSources: ["project"]` may not be a complete block. The prepended line is the override until that source is known.

### D-12: No read-only mode in v1 (accepted)

The agent can run shell and edit tools. This version has no toggle that removes them. The setup screen says the agent acts without asking first.
**Reason:** Valentin, 2026-11-05.
**Rejected:** a read-only toggle in v1.

## Open questions

| ID | Question | Answer | Owner |
|----|----------|--------|-------|
| Q-1 | One chat per folder, or several? | **Answered (Valentin, 2026-11-05):** one chat per folder. See D-5 | none |
| Q-2 | Edit user-level rules and skills in `~/.cursor`? | **Answered (Valentin, 2026-11-05):** do not edit them. Override them for this agent. See D-11 | none |
| Q-3 | How many past messages to seed on a failed resume? | **Answered (Valentin, 2026-11-05):** the last 20 messages, text only. See D-7 | none |
| Q-4 | A read-only mode (no shell or edit tools)? | **Answered (Valentin, 2026-11-05):** not in v1. See D-12 | none |
| Q-5 | Does `Agent.resume(agentId, options)` re-read the project's rules and skills? | **Answered (2026-11-05):** the reply kept the old rule ending after the file changed. Recreate the agent after an edit | none |
| Q-6 | Does the SDK take the key as an option, or only from the environment? | **Answered (1.2.0 typings):** explicit `apiKey` option, always passed | none |

## Phase 0 spike checklist

Rows marked reused were not run again. The gap script ran on 2026-11-05. Detail is in [phase0-spike.md](phase0-spike.md).

| Check | Decides | State |
|-------|---------|-------|
| Local streaming, cancel, and usage | chat stream, Stop | Reused: Mango S1, passed 2026-11-02 |
| `settingSources: ["project"]` loads project hooks | D-3 | Reused: Mango S3, passed 2026-11-02, for hooks. A project rule and a skill passed in the gap script on 2026-11-05 |
| SDK runs in Electron's main process | D-2 | Reused: Mango S22, passed 2026-11-03 |
| `Agent.resume` after a kill mid-run | D-7 | Reused: Mango S8, failed with "already has active run", 2026-11-04 |
| Explicit `apiKey` is accepted | Q-6 | Answered from the 1.2.0 typings. A live run was not repeated |
| Agent follows a rule and sees a skill | D-3 | Passed 2026-11-05. Reply contained the skill secret and `ANCHOR` |
| Native `askQuestion` appears and blocks, or not | D-4 | Did not appear. Run finished with `NO_ASK_TOOL` |
| `customTools.ask_user_question` waits 5 s and the token comes back | D-4 | Passed. Waited 5001 ms. Reply contained the token |
| The agent calls the custom tool when told to | D-4 | Passed. Arguments parsed |
| `Agent.resume` after a clean finish keeps the secret word | D-7 | Passed. A second process resumed the agent and repeated the secret |
| `Agent.resume` re-reads a changed rule file | Q-5, D-8 | Did not apply. Reply kept `ANCHOR` after the file said `BEACON` |
| `customTools.execute` that waits more than 60 s is not cut off | D-4 | Not in the script. The 5 s wait is the check the plan asks for |
