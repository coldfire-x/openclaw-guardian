import fs from "node:fs/promises";

const FATAL_PATTERNS = [
  /panic/i,
  /fatal/i,
  /segfault/i,
  /out of memory/i,
  /oom/i,
  /traceback/i
];

export interface LogProbeResult {
  tail: string;
  matchedPatterns: string[];
}

async function readTail(logPath: string, maxBytes = 64 * 1024): Promise<string> {
  const handle = await fs.open(logPath, "r");

  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const offset = Math.max(0, stats.size - length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function probeLogs(logPath: string): Promise<LogProbeResult> {
  try {
    const tail = await readTail(logPath);
    const matchedPatterns = FATAL_PATTERNS.filter((pattern) => pattern.test(tail)).map((pattern) => pattern.source);

    return {
      tail,
      matchedPatterns
    };
  } catch {
    return {
      tail: "",
      matchedPatterns: []
    };
  }
}
