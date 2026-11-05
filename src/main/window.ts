// The one main-process file that builds the window.
// Context isolation on, Node integration off, sandbox on, no remote URL.
// Navigation and window.open are refused. Every permission request is denied.
import { BrowserWindow, session } from "electron";
import path from "node:path";

export function createMainWindow(distDir: string): BrowserWindow {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: "Mango",
    backgroundColor: "#f6efe4",
    minWidth: 720,
    minHeight: 560,
    webPreferences: {
      preload: path.join(distDir, "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());

  void window.loadFile(path.join(distDir, "renderer", "index.html"));
  return window;
}
