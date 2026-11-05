// Confirms the packaged app unpacked @cursor/sdk-darwin-* and that the app process stays up.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const app = findApp(path.resolve("release"));
if (app === null) {
  console.error("No .app under release/. Run npm run dist first.");
  process.exit(1);
}

const unpackedRoot = path.join(app, "Contents", "Resources", "app.asar.unpacked", "node_modules", "@cursor");
const sdkDir = findSdkDir(unpackedRoot);
if (sdkDir === null) {
  console.error("Native SDK package is still inside the asar:", unpackedRoot);
  process.exit(1);
}

const rg = path.join(sdkDir, "bin", "rg");
const bindings = [
  path.join(sdkDir, "vendor", "tree-sitter", "binding.node"),
  path.join(sdkDir, "vendor", "tree-sitter-bash", "binding.node"),
];
for (const file of [rg, ...bindings]) {
  if (!existsSync(file)) {
    console.error("Missing unpacked file:", file);
    process.exit(1);
  }
}
if ((statSync(rg).mode & 0o111) === 0) {
  console.error("rg is not executable:", rg);
  process.exit(1);
}

const binary = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
const probe = spawn(binary, ["-e", probeSource(rg, bindings)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
const probeResult = await finished(probe);
if (probeResult.code !== 0) {
  console.error(probeResult.stderr || probeResult.stdout);
  process.exit(1);
}
process.stdout.write(probeResult.stdout);

const userData = mkdtempSync(path.join(tmpdir(), "mango-package-"));
const launched = spawn(binary, [`--user-data-dir=${userData}`], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let logs = "";
launched.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
launched.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});
const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 4000);
  launched.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
try {
  if (exitCode !== null) {
    console.error(`Packaged app exited with ${exitCode}`);
    console.error(logs);
    process.exit(1);
  }
  // A normal quit goes through before-quit and can stay open. The process group includes the helpers.
  process.kill(-launched.pid, "SIGKILL");
  await new Promise((resolve) => launched.once("exit", resolve));
  console.log("app-ok", app);
} finally {
  rmSync(userData, { recursive: true, force: true });
}

function probeSource(ripgrep, nativeBindings) {
  return `
    const { spawnSync } = require("node:child_process");
    const rg = ${JSON.stringify(ripgrep)};
    for (const binding of ${JSON.stringify(nativeBindings)}) {
      require(binding);
    }
    const result = spawnSync(rg, ["--version"], { encoding: "utf8" });
    if (result.status !== 0) {
      console.error(result.stderr || "rg failed");
      process.exit(1);
    }
    console.log("native-ok", result.stdout.split("\\n")[0]);
  `;
}

function findSdkDir(root) {
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    if (name.startsWith("sdk-darwin-")) return path.join(root, name);
  }
  return null;
}

function findApp(dir) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".app")) return full;
    const nested = findApp(full);
    if (nested !== null) return nested;
  }
  return null;
}

function finished(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
