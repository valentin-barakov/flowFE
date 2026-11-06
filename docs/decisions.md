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

### D-5: One chat per repo (accepted)

The saved folder is a workspace. Each git repo in it has one chat file, `chats/<sha256 of the repo real path>.json`, and one agent. Agents in different repos run at the same time. A second agent in the same repo is refused. "Reset chat" drops that repo's `agentId` and messages. The home screen picks a repo with `@name`. A workspace that is itself one repo, or that contains no repos, has one chat and no home screen.
**Reason:** Valentin, 2026-11-06. One agent per repo keeps that repo on one branch. Parallel repos are the point of the workspace.
**Rejected:** several chats per repo (needs a list and a separate `agentId` for each); one agent for the whole workspace (cannot run two repos at once).

### D-6: Persistence is JSON files with atomic writes, no database (accepted)

`settings.json`, `chats/<folderId>.json`, and `secrets.bin` in `userData`. One writer in main; temp file plus rename.
**Reason:** one conversation per repo and a small message list. A database adds a dependency and a native build for no query need.
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

### D-13: Conversation mode is Agent or Plan (accepted)

The workspace has one mode, `agent` or `plan`, stored in `settings.json`. A missing field reads as `agent`. Each send passes that mode to the SDK on `Agent.create` and on `agent.send`. Changing it does not create a new agent, and it is refused while any repo is busy, the same as changing the model. A finished `createPlan` tool is shown as a rendered plan card. The user switches back to Agent and sends another message to have the work implemented.

**Reason:** Valentin, 2026-11-06. `@cursor/sdk` 1.2.0 `AgentModeOption` is `"agent" | "plan"`.
**Rejected:** Ask mode or a read-only tool lock (still D-12); a separate mode per repo; a Build button.

### D-14: Markdown in the chat uses `react-markdown` and `remark-gfm` (accepted)

Agent text and plan cards render through `react-markdown` 10.1.0 with `remark-gfm` 4.0.1, pinned exactly, as `devDependencies` (Vite bundles them into the window). The options live in `src/renderer/markdown-config.ts`. Raw HTML is not enabled, images are dropped, and a link is shown as styled text because the window refuses navigation and has no open-external command.
**Reason:** Valentin, 2026-11-06. The agent writes tables, nested lists, and half-finished text while streaming, and the hand-written parser covered only headings, paragraphs, flat lists, fences, inline code, and bold. The library builds React elements and never inserts HTML, so it fits the locked renderer.
**Rejected:** `marked` or `markdown-it` (HTML strings, so a sanitizer is also needed); `streamdown` (built for streaming, but brings code highlighting and Tailwind-oriented styling this app does not use); extending the hand-written parser (Mango would own a markdown parser).
**Still open:** clickable links need an IPC command that checks `http(s)` and calls `shell.openExternal` in main.

### D-15: Diagrams and charts use `mermaid`, shown as an image (accepted)

A fenced `mermaid` block in agent text or a plan is drawn with `mermaid` 12.3.0, pinned exactly, as a `devDependency`. The library is loaded with a dynamic import on the first diagram. It runs with `securityLevel: "strict"` and plain SVG labels. The SVG is shown through `<img>` with a data URL. A block in a message that is still streaming is shown as code. A block that does not parse is shown as code with a note. The page CSP is not changed.
**Reason:** Valentin, 2026-11-06. Plans and replies contain flowcharts and sequence diagrams as `mermaid` fences, and they showed as code. Mermaid draws flowcharts, sequence, state, ER, class, gantt, pie, and `xychart` charts, which covers the diagrams the agent writes. An `<img>` cannot run script or load other resources, so the locked renderer stays as it is.
**Rejected:** inserting the SVG into the page with `dangerouslySetInnerHTML` (the sanitizer would be the only guard); rendering diagrams in main or in a hidden window (a new process boundary); a charting library such as Chart.js (a second format the agent does not write); leaving diagrams as code.
**Still open:** zoom, pan, and export of a diagram; text inside a diagram image cannot be selected.

### D-16: Jira tickets are read with an API token, in main (accepted)

A Jira control shows the issues assigned to the user whose status category is not Done. The user creates an API token at id.atlassian.com and pastes the Atlassian email, the site (`https://<name>.atlassian.net`), and the token into Setup. Main stores all three in `userData/jira.bin`, encrypted with `safeStorage`. Search is `POST https://<site>.atlassian.net/rest/api/3/search/jql` with Basic auth (`email:token`), 50 per page, followed only by Jira's `nextPageToken`. The query is `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. A row opens in the system browser through `flow:jira.open`, which builds `https://<site>.atlassian.net/browse/<KEY>` in main. The token is sent only to that stored origin. No dependency is added.
**Reason:** Valentin, 2026-11-06. Atlassian 3LO needs an `https` callback, and the developer console rejects `http://127.0.0.1`, so a loopback sign-in cannot be registered. An API token is what Atlassian documents for a script calling the Cloud REST API.
**Rejected:** OAuth 3LO with a loopback callback (the console will not save `http://127.0.0.1:47821/callback`); OAuth with a public relay or a tunnel (a host to run, and the code would leave the Mac); a Mango-owned OAuth client (a secret cannot be kept in a desktop app); loading Jira in the window (the window loads no remote URL); a generic "open any URL" command (D-14 still wants one, and this is narrower); giving the agent Jira tools (out of scope); caching tickets on disk.
**Accepted trade-off:** the token is not scoped. It can do whatever the account can do, until the user revokes it or the expiry they set is reached. Mango only searches and opens browse URLs.
**Still open:** the live search needs a real token and site. It is a manual check, not part of `npm run check:jira`.

### D-17: GitHub pull requests and projects are read with two optional pasted tokens, in main (accepted)

Two optional sections, each behind its own token, both classic personal access tokens pasted in Setup and stored in `userData/github.bin`, encrypted with `safeStorage`. The **repos token** (classic, `repo`) turns on **Pull requests**: the user picks up to 30 repositories from `GET /user/repos`, and the pane shows one tab per repo with its 50 most recently updated open pull requests, read with one GraphQL call each (draft, review decision, last-commit check state). The **Projects token** (classic, only `read:project`) turns on **Projects**: the user picks up to 10 personal Projects (v2) from `viewer.projectsV2`, and the pane is the Jira board with GitHub items (three columns through `ticketColumn`, Implement button, Load more). A section whose token is not saved is not shown. Every request is made in main to `https://api.github.com` with `fetch` and a Bearer token; a `Link` page is followed only on that origin. A **Get token** button opens GitHub's "new token" page from a fixed table in main with the scope and a note filled in. A row opens `https://github.com/<owner>/<repo>/(pull|issues)/<n>`, built in main from a name that matches a strict pattern. Mango never writes to GitHub. No dependency is added.
**Reason:** Valentin, 2026-11-06. A fine-grained token cannot read a user-owned Project (Mango ADR-0008, spike S7), so Projects needs a classic `read:project` token, while pull requests across private repos in an account and its organizations need a classic `repo` token. Two tokens let someone turn on only the section they want and keep the broader `repo` scope out of the Projects flow. GraphQL gives pull requests with review and CI state in one call per repo and is the only API for Projects (v2).
**Rejected:** OAuth device flow or a Mango-owned OAuth app (a client secret cannot be kept in a desktop app, and a device flow needs a registered app); one combined token (forces the broad `repo` scope on someone who only wants Projects); fine-grained tokens only (cannot read a personal project, and cover one owner); Octokit (retry and throttling, but a new dependency for four calls; flowFE has none, Mango ADR-0008 names it); loading GitHub in the window (the window loads no remote URL); a generic "open any URL" command (D-14 still wants one, and this is narrower); org-owned projects, GitHub Enterprise, and any write to GitHub (out of scope); caching lists on disk.
**Accepted trade-off:** a classic `repo` token can write to GitHub, and a classic token cannot be limited to chosen repositories. Mango only reads. Setup says so and tells the user to set an expiry of 30 to 90 days, because GitHub's token page URL cannot preset one.
**Still open:** the live lists need real tokens, repos, and a project. They are manual checks, not part of `npm run check:github`. Octokit, an "assigned to me" filter on the Projects board, and org-owned projects can be added later.

## Open questions

| ID | Question | Answer | Owner |
|----|----------|--------|-------|
| Q-1 | One chat per folder, or several? | **Answered (Valentin, 2026-11-06):** one chat per repo inside a workspace folder. Several repos run at once. See D-5 | none |
| Q-2 | Edit user-level rules and skills in `~/.cursor`? | **Answered (Valentin, 2026-11-05):** do not edit them. Override them for this agent. See D-11 | none |
| Q-3 | How many past messages to seed on a failed resume? | **Answered (Valentin, 2026-11-05):** the last 20 messages, text only. See D-7 | none |
| Q-4 | A read-only mode (no shell or edit tools)? | **Answered (Valentin, 2026-11-05):** not in v1. See D-12 | none |
| Q-5 | Does `Agent.resume(agentId, options)` re-read the project's rules and skills? | **Answered (2026-11-05):** the reply kept the old rule ending after the file changed. Recreate the agent after an edit | none |
| Q-6 | Does the SDK take the key as an option, or only from the environment? | **Answered (1.2.0 typings):** explicit `apiKey` option, always passed | none |
| Q-7 | How does Mango sign in to Jira if localhost OAuth callbacks are rejected? | **Answered (Valentin, 2026-11-06):** an API token, email, and one site address. See D-16 | none |

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
