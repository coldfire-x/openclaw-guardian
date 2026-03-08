import os from "node:os";
import path from "node:path";

export function getStateDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".openclaw-guardian");
}
