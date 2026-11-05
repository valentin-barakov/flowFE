// Electron main process entry. Do not await app.whenReady() at the top level: Electron loads this
// module before it emits ready, so that await never finishes and the app hangs with no window.
import { app, BrowserWindow, nativeImage, safeStorage } from "electron";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { QuestionRejected, QUESTION_CANCELLED, type AskUser } from "../shared/questions.js";
import { createAgentService } from "./agent-service.js";
import { createChatSession } from "./chat-session.js";
import { publish, registerIpc, type IpcHost } from "./ipc.js";
import { createRulesSkills } from "./rules-skills-service.js";
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
  const files = createRulesSkills({ folder: () => store.view().folder });
  const askBridge: { ask: AskUser | null } = { ask: null };
  const agents = createAgentService({
    ask(request) {
      const ask = askBridge.ask;
      if (ask === null) return Promise.reject(new QuestionRejected("cancelled", QUESTION_CANCELLED));
      return ask(request);
    },
  });
  const session = createChatSession({
    store,
    agents,
    files,
    emit: (event) => publish(host, event),
  });
  askBridge.ask = (request) => session.ask(request);
  registerIpc(host, session, files);
  attach(createMainWindow(distDir));
  app.on("activate", () => {
    if (host.window === null) attach(createMainWindow(distDir));
  });
  app.on("before-quit", (event) => {
    if (session.isShuttingDown()) return;
    event.preventDefault();
    void session.shutdown().finally(() => app.quit());
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

adoptLegacyData();
void app.whenReady().then(start);
