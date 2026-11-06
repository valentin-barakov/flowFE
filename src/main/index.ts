// Electron main process entry. Do not await app.whenReady() at the top level: Electron loads this
// module before it emits ready, so that await never finishes and the app hangs with no window.
import { app, BrowserWindow, nativeImage, safeStorage, shell } from "electron";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { QuestionRejected, QUESTION_CANCELLED } from "../shared/questions.js";
import { createAgentService } from "./agent-service.js";
import { createGithubService } from "./github-service.js";
import { existingReviewFile, localRepoPath } from "./pr-review-file.js";
import { publish, registerIpc, type IpcHost } from "./ipc.js";
import { createJiraService } from "./jira-service.js";
import { createRulesSkills } from "./rules-skills-service.js";
import { createSessionManager } from "./session-manager.js";
import { createSettingsStore } from "./settings-store.js";
import { createMainWindow } from "./window.js";

const distDir = path.resolve(import.meta.dirname, "..");
const host: IpcHost = { window: null, senderId: -1 };

function attach(window: BrowserWindow): void {
  host.window = window;
  host.senderId = window.webContents.id;
  window.on("closed", () => {
    if (host.window === window) {
      host.window = null;
      host.senderId = -1;
    }
  });
}

function applyDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged || app.dock === undefined) return;
  const iconPath = path.join(app.getAppPath(), "build", "icon.png");
  if (!existsSync(iconPath)) return;
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) app.dock.setIcon(image);
}

function adoptLegacyData(): void {
  // productName is Mango, so this launch stores data in Application Support/Mango.
  // Builds before the rename used Application Support/flowfe.
  const next = path.join(app.getPath("appData"), "Mango");
  const previous = path.join(app.getPath("appData"), "flowfe");
  if (existsSync(next) || !existsSync(previous)) return;
  try {
    renameSync(previous, next);
  } catch {
    // The older app may still have that folder open. This launch starts empty.
  }
}

function start(): void {
  applyDockIcon();
  const store = createSettingsStore({ userDataDir: app.getPath("userData"), secrets: safeStorage });
  const files = createRulesSkills();
  const jira = createJiraService({
    userDataDir: app.getPath("userData"),
    secrets: safeStorage,
    // Only https://<site>.atlassian.net/browse/<KEY>, built in jira-service, reaches this function.
    openExternal: (url) => shell.openExternal(url),
  });
  const github = createGithubService({
    userDataDir: app.getPath("userData"),
    secrets: safeStorage,
    // Only https://github.com/settings/tokens/new?... (a fixed table) and
    // https://github.com/<owner>/<repo>/(pull|issues)/<n>, both built in github-service, reach this function.
    openExternal: (url) => shell.openExternal(url),
    // reviewFile only returns <checkout>/pr-reviews/<number>.md. openPath receives that path.
    reviewFile: (repo, number) => {
      const current = store.view();
      if (current.folder === null || current.folderMissing) return null;
      const checkout = localRepoPath(repo, store.listRepos(current.folder));
      if (checkout === null) return null;
      return existingReviewFile(checkout, number);
    },
    openPath: async (file) => {
      const error = await shell.openPath(file);
      if (error !== "") throw new Error(error);
    },
  });
  const models = createAgentService({
    ask() {
      return Promise.reject(new QuestionRejected("cancelled", QUESTION_CANCELLED));
    },
  });
  const manager = createSessionManager({
    store,
    files,
    emit: (event) => publish(host, event),
    listModels: (key) => models.listModels(key),
    createAgents: (ask) => createAgentService({ ask }),
  });
  registerIpc(host, manager, files, jira, github);
  attach(createMainWindow(distDir));
  app.on("activate", () => {
    if (host.window === null) attach(createMainWindow(distDir));
  });
  app.on("before-quit", (event) => {
    if (manager.isShuttingDown()) return;
    event.preventDefault();
    void manager.shutdown().finally(() => app.quit());
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

adoptLegacyData();
void app.whenReady().then(start);
