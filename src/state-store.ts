import fs from "node:fs/promises";
import path from "node:path";
import { GuardianState } from "./types.js";
import { getStateDir } from "./paths.js";

const STATE_DIR = getStateDir();
const STATE_PATH = path.join(STATE_DIR, "state.json");

const DEFAULT_STATE: GuardianState = {
  status: "HEALTHY",
  consecutiveMissingProcessCount: 0,
  healthyStreak: 0
};

export class StateStore {
  async load(): Promise<GuardianState> {
    try {
      const data = await fs.readFile(STATE_PATH, "utf8");
      return {
        ...DEFAULT_STATE,
        ...(JSON.parse(data) as Partial<GuardianState>)
      };
    } catch {
      await this.save(DEFAULT_STATE);
      return structuredClone(DEFAULT_STATE);
    }
  }

  async save(state: GuardianState): Promise<void> {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const tempPath = `${STATE_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tempPath, STATE_PATH);
  }
}
