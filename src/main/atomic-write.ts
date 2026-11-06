// Temp file, mode 0600, then rename. Shared by settings-store and jira-service (D-6).
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function writeAtomic(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}
