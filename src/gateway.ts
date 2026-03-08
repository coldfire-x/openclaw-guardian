import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { logger } from "./logger.js";
import { probeProcess } from "./probes/process.js";

const GATEWAY_COMMAND = ["openclaw", "gateway"];
const START_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 10_000;

interface GatewayRestartResult {
  success: boolean;
  previousState: "running" | "stopped" | "dead";
  message: string;
  logLines?: string;
}

async function readLastLines(filePath: string, lineCount: number): Promise<string> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stats = await handle.stat();
      const maxBytes = 64 * 1024; // Read at most 64KB
      const startBytes = Math.max(0, stats.size - maxBytes);
      const buffer = Buffer.alloc(stats.size - startBytes);
      await handle.read(buffer, 0, buffer.length, startBytes);
      const content = buffer.toString("utf8");
      const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
      return lines.slice(-lineCount).join("\n");
    } finally {
      await handle.close();
    }
  } catch {
    return "(could not read log file)";
  }
}

function runCommand(command: string[], timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim()
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}

async function killProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");

    // Wait for process to terminate gracefully
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        process.kill(pid, 0); // Check if still exists
      } catch {
        return true; // Process is gone
      }
    }

    // Force kill if still running
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore if already gone
    }
    return true;
  } catch {
    return false;
  }
}

async function startGateway(): Promise<{ success: boolean; message: string }> {
  try {
    const child = spawn(GATEWAY_COMMAND[0], GATEWAY_COMMAND.slice(1), {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true
    });

    child.unref();

    // Wait a moment and check if process is still running
    await new Promise((r) => setTimeout(r, 2000));

    try {
      process.kill(child.pid!, 0); // Check if process exists
      return { success: true, message: `Gateway started (PID: ${child.pid})` };
    } catch {
      return { success: false, message: "Gateway process terminated shortly after start" };
    }
  } catch (error) {
    return {
      success: false,
      message: `Failed to start gateway: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export async function restartGateway(processName: string, logPath?: string): Promise<GatewayRestartResult> {
  const probe = await probeProcess(processName);

  // Determine previous state
  let previousState: "running" | "stopped" | "dead" = "stopped";
  if (probe.running) {
    // Check if process is actually responsive (not zombie/dead)
    const hasDeadIndicators = probe.matches.some(
      (p) => p.cmd?.includes("<defunct>") || p.cmd?.includes("[")
    );
    previousState = hasDeadIndicators ? "dead" : "running";
  }

  logger.info(`Gateway restart requested. Current state: ${previousState}`);

  // Kill existing process(es) if any
  if (probe.running && probe.matches.length > 0) {
    logger.info(`Stopping ${probe.matches.length} gateway process(es)`);
    for (const match of probe.matches) {
      await killProcess(match.pid);
    }

    // Verify all processes are gone
    await new Promise((r) => setTimeout(r, 1000));
    const verifyProbe = await probeProcess(processName);
    if (verifyProbe.running) {
      return {
        success: false,
        previousState,
        message: `Failed to stop existing gateway process(es). Still running: ${verifyProbe.matches.map((m) => m.pid).join(", ")}`
      };
    }
  }

  // Start the gateway
  const startResult = await startGateway();

  if (!startResult.success) {
    return {
      success: false,
      previousState,
      message: startResult.message
    };
  }

  // Wait and verify it started properly
  await new Promise((r) => setTimeout(r, 3000));
  const finalProbe = await probeProcess(processName);

  if (!finalProbe.running) {
    return {
      success: false,
      previousState,
      message: `${startResult.message}, but process is not running after 3s`
    };
  }

  // Read last 10 lines of log if path provided
  const logLines = logPath ? await readLastLines(logPath, 10) : undefined;

  return {
    success: true,
    previousState,
    message: `${startResult.message}. Gateway is now running.`,
    logLines
  };
}
