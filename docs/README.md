# Mango documentation

Mango is a small Electron + React Mac app that runs local Cursor agents (`@cursor/sdk`, local runtime) in a workspace folder the user picks. Each git repo has one chat. The user edits the open repo's rules and skills in the app and chats with that repo's agent. The agent can ask the user questions as forms.

The delivery plan is [.cursor/plans/cursor_agent_mac_app_1b2c39e4.plan.md](../.cursor/plans/cursor_agent_mac_app_1b2c39e4.plan.md). These documents describe the design that plan builds.

| Document | Read it to learn |
|----------|------------------|
| [architecture.md](architecture.md) | Process layout, modules, who owns what data, security boundaries, folder layout |
| [ipc-contract.md](ipc-contract.md) | Every command and event between the window and the main process |
| [session-and-questions.md](session-and-questions.md) | The chat state machine, the question flow, restart and recovery |
| [decisions.md](decisions.md) | Design decisions with reasons and rejected alternatives, plus open questions |
| [phase0-spike.md](phase0-spike.md) | Phase 0 results: custom question tool, resume, and what was reused from Mango |

## Status

The app in the repo has system, light, and dark themes, error banners, New chat, a model picker, rules and skills editing, question forms, and an unsigned local `.app`. `npm start` builds and opens the window. `npm run dist` writes `release/mac-arm64/Mango.app` and checks the unpacked SDK package. `npm run typecheck`, `npm run check:questions`, `npm run check:mentions`, and `npm run check:repos` pass. Question parsing is checked by `npm run check:questions` (`scripts/phase3-questions-check.ts`). A wait of several minutes inside a question tool is still unmeasured. The file-service checks live in `scripts/phase2-files-check.mjs`.

## Conventions

- **Unverified:** a claim about the SDK or Electron that the Phase 0 spike must confirm.
- **Open question:** a decision still to make; each one is listed in [decisions.md](decisions.md).
- Diagrams are Mermaid.
- The product is a sibling of the `mango` repo, not part of it. That repo's ADRs and doc rules do not apply here. Its window security setup, `safeStorage` use, and measured SDK findings are reused and cited as that repo's spikes S3 and S8.
