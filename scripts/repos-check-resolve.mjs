// Resolver for `npm run check:repos` only. App files keep NodeNext `.js` specifiers.
// This maps a relative `.js` import to the sibling `.ts` file when that file is the one on disk.
import { existsSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread) register(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  const parentURL = context.parentURL;
  if (parentURL === undefined || !parentURL.startsWith("file:") || !isRelativeJs(specifier)) {
    return nextResolve(specifier, context);
  }
  const directory = path.dirname(fileURLToPath(parentURL));
  const base = specifier.slice(0, -3);
  const tsPath = path.resolve(directory, `${base}.ts`);
  if (!existsSync(tsPath) || existsSync(path.resolve(directory, specifier))) {
    return nextResolve(specifier, context);
  }
  return nextResolve(`${base}.ts`, context);
}

function isRelativeJs(specifier) {
  return (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js");
}
