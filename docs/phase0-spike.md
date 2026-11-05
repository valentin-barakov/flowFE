# Phase 0 spike

Ran on 2026-11-05 with the key from `.env` (`keySource: env`). Model `composer-2.5`. The raw JSON is in `.spike/phase0-result.json` (gitignored). Questions use the custom tool. See D-4 in [decisions.md](decisions.md).

## Result

| Check | Result |
|-------|--------|
| Rule and skill | Passed. The reply contained the skill's secret word and ended with `ANCHOR`. |
| Custom tool | Passed. `ask_user_question` was called, the arguments parsed, the wait was 5001 ms, and the reply contained the returned token. |
| Native `askQuestion` | Not available. The stream had no such call. The run finished, and the reply was `NO_ASK_TOOL`. |
| Clean resume | Passed. A second process resumed the agent and repeated the secret word. |
| Resume re-reads a changed rule | Did not apply. The rule file was changed to `BEACON` before resume. The reply still used `ANCHOR`. An edit creates a new agent. |

The SDK log also loaded 23 skills for an empty folder, and 24 where the temp project had one skill. Project rules were scoped: `ruleCount` was 1 in the project and 0 in the empty folder. The folder picker should keep saying that the chosen folder is not the only instruction source.

A wait of several minutes inside `execute` was not measured.

## Reused from Mango

These were not run again. Sources are `mango/docs/03-feasibility.md` and `mango/docs/decisions/0009-cursor-sdk-local-runtime.md`. All of them used `@cursor/sdk` 1.2.0.

| Check | Sibling project result | What this app takes from it |
|-------|------------------------|------------------------------|
| Streaming, cancel, usage, no approval prompt | S1 passed, 2026-11-02 | The chat stream and Stop are feasible. S1 did not try `Agent.resume`. |
| `settingSources: ["project"]` | S3 passed for hooks, 2026-11-02. Without it, project hooks did not run. | Project hooks load only when `settingSources` is `["project"]`. |
| `Agent.resume` after a kill mid-run | S8, 2026-11-04. The agent stayed `running`. Resume failed: `already has active run`. | An in-flight run is not recovered. The app keeps its own messages. |
| SDK inside Electron's main process | S22 passed, 2026-11-03 | Main may call the SDK. |
| Explicit `apiKey` option | SDK 1.2.0 typings, not a Mango run | `agent-service` will pass the key. Precedence is the option, then `CURSOR_API_KEY`, then a stored `Cursor.auth.login()` key. |
