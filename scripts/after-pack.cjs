const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

// Native binaries cannot run from inside app.asar. electron-builder unpacks them;
// this restores the executable bit the SDK expects on rg and cursorsandbox.
module.exports = async function afterPack(context) {
  const resources = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "@cursor",
  );
  if (!existsSync(resources)) return;
  for (const name of readdirSync(resources)) {
    if (!name.startsWith("sdk-darwin-")) continue;
    const bin = path.join(resources, name, "bin");
    if (!existsSync(bin)) continue;
    for (const file of readdirSync(bin)) {
      const target = path.join(bin, file);
      if (statSync(target).isFile()) chmodSync(target, 0o755);
    }
  }
};
