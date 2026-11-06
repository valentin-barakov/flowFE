# Mango

A local Mac app that chats with Cursor agents in a workspace folder you pick. Each git repo in that folder has its own chat, and agents in different repos can run at the same time. You can edit the open repo's rules and skills in the app. Cursor skills from your user folder are listed on that screen and loaded into the agent. The app does not change them. The agent can ask you questions as a form.

When the workspace has several repos, the left menu lists the chats that are running or already have history. Remove clears that chat and takes it off the list. If that chat is the one on screen, the window returns to New chat.

The chat has an Agent or Plan control. Agent is the default. In Plan mode, a plan the agent writes is shown as a document in the thread.

Jira is optional. In Setup, paste your Atlassian account email, the site address (`https://<your-site>.atlassian.net`), and an API token from `https://id.atlassian.com/manage-profile/security/api-tokens`. The token is encrypted with `safeStorage` and never shown again. It is not scoped: it can do what that account can do, and Mango only uses it to list the tickets assigned to you that are not Done. The Jira button opens that list in place of the chat (under New chat in the left menu, or in the chat header when the workspace has one repo). Back, or a left-menu agent, returns to the chat. A row opens the issue in your browser.

GitHub is optional and read-only, with two sections that each need their own token (Setup has a **Get token** button for each). A classic token with `repo` turns on **Pull requests**: pick repositories in Setup and the pane shows one tab per repo with its open pull requests, with Draft, review, and CI chips. A classic token with only `read:project` turns on **Projects**: pick your personal projects in Setup and the pane shows the same board as Jira (To Do, In Progress, In Review), with an Implement button. A section with no token is not shown. A fine-grained token cannot read a personal project, so the Projects token must be classic. A classic `repo` token can write to GitHub even though Mango never does: set an expiry of 30 to 90 days. Tokens are encrypted with `safeStorage` and never shown again. The buttons are under Jira in the left menu, or in the chat header when the workspace has one repo. On the Pull requests pane, a PR you have not approved has a **Review** button when the workspace has a checkout of that repo. It sends `review pr <url>` to that repo's agent, shows a spinner while it runs, and shows **Yes** or **No** and **See review** when `pr-reviews/<number>.md` is saved. The word comes from the `## Verdict` section at the top of that file. The prompt tells that agent to read `~/.cursor/skills/pr-review/SKILL.md` and follow it. The file is written only in Agent mode, because Plan mode cannot write it.

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
npm run check:fruits
npm run check:plan
npm run check:segments
npm run check:tools
npm run check:jira
npm run check:github
```

Question-argument parsing is covered by `npm run check:questions`. File-path checks live in `scripts/phase2-files-check.mjs`.

`check:mentions` covers `@repo` parsing. `check:repos` covers repo discovery, two sessions at once, and the text offset saved on each tool line and question. `check:sidebar` covers which left-menu rows remain after a chat is cleared, including the return to New chat when several repos are open. `check:fruits` covers which fruit icon a chat keeps, and that two chats one above the other do not share one. `check:plan` covers markdown rendering, diagram helpers, and the `createPlan` name match. `check:segments` covers how a run's text, tool calls, and cards are put in order. `check:tools` covers the one-line tool summary. `check:repos`, `check:segments`, and `check:tools` use `scripts/repos-check-resolve.mjs` so Node can load the app's `.js` specifiers. File-path checks stay in `scripts/phase2-files-check.mjs`. `check:jira` covers the site check, the issue key, the search request (Basic auth, the JQL, and the page token), and the renderer state that opens and closes the ticket list. The live list needs a real API token and is checked by hand. `check:github` covers the repo and project id checks, the `/user/repos` `Link` pagination and its cap, the pull request and project item requests and parsing, the done filter, the refusal of an unpicked repo or project, the fixed token-page table, each section being unavailable without its token, tokens never appearing in the status or on disk, and the reducer state that switches between Jira, Pull requests, and Projects. The live lists need real tokens and are checked by hand.
