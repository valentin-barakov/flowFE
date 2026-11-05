# Mango

A local Mac app that chats with one Cursor agent in a folder you pick. You can edit that folder's rules and skills in the app. The agent can ask you questions as a form.

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
```

Question-argument parsing is covered by `npm run check:questions`. File-path checks live in `scripts/phase2-files-check.mjs`.
