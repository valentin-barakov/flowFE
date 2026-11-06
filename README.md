# Mango

A local Mac app that chats with Cursor agents in a workspace folder you pick. Each git repo in that folder has its own chat, and agents in different repos can run at the same time. You can edit the open repo's rules and skills in the app. The agent can ask you questions as a form.

When the workspace has several repos, the left menu lists the chats that are running or already have history. Remove clears that chat and takes it off the list. If that chat is the one on screen, the window returns to New chat.

The chat has an Agent or Plan control. Agent is the default. In Plan mode, a plan the agent writes is shown as a document in the thread.

Jira is optional. In Setup, paste your Atlassian account email, the site address (`https://<your-site>.atlassian.net`), and an API token from `https://id.atlassian.com/manage-profile/security/api-tokens`. The token is encrypted with `safeStorage` and never shown again. It is not scoped: it can do what that account can do, and Mango only uses it to list the tickets assigned to you that are not Done. The Jira button opens that list in place of the chat (under New chat in the left menu, or in the chat header when the workspace has one repo). Back, or a left-menu agent, returns to the chat. A row opens the issue in your browser.

The agent runs on this Mac through `@cursor/sdk` (local runtime). The model is still served by Cursor, so the app needs a Cursor API key. The key is stored with Electron `safeStorage` and is never shown again.

## Run

Node.js 22.13 or newer.

```bash
npm install
npm start
```

`npm start` builds the main process, the preload script, and the window, then opens Mango.

## Build an unsigned .app

```bash
npm run dist
```

The app is written to `release/mac-arm64/Mango.app`. It is not signed and there is no auto-update. macOS may refuse the first open from Finder; right-click the app and choose Open, or launch `Mango.app/Contents/MacOS/Mango` directly.

`npm run dist` also checks that `@cursor/sdk-darwin-arm64` was unpacked from the asar archive, that its `rg` binary runs, that the tree-sitter `.node` files load, and that the `.app` stays running after startup.

## Checks

```bash
npm run typecheck
npm run check:questions
npm run check:mentions
npm run check:repos
npm run check:sidebar
npm run check:plan
npm run check:segments
npm run check:tools
npm run check:jira
```

Question-argument parsing is covered by `npm run check:questions`. File-path checks live in `scripts/phase2-files-check.mjs`.

`check:mentions` covers `@repo` parsing. `check:repos` covers repo discovery, two sessions at once, and the text offset saved on each tool line and question. `check:sidebar` covers which left-menu rows remain after a chat is cleared, including the return to New chat when several repos are open. `check:plan` covers markdown rendering, diagram helpers, and the `createPlan` name match. `check:segments` covers how a run's text, tool calls, and cards are put in order. `check:tools` covers the one-line tool summary. `check:repos`, `check:segments`, and `check:tools` use `scripts/repos-check-resolve.mjs` so Node can load the app's `.js` specifiers. File-path checks stay in `scripts/phase2-files-check.mjs`. `check:jira` covers the site check, the issue key, the search request (Basic auth, the JQL, and the page token), and the renderer state that opens and closes the ticket list. The live list needs a real API token and is checked by hand.
