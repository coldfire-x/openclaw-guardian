import { spawn } from "node:child_process";
import { DoctorReport } from "./types.js";

const DIAGNOSE_COMMAND = ["openclaw", "doctor", "--yes"];
const FIX_COMMAND = ["openclaw", "doctor", "--fix", "--non-interactive"];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Strip ANSI escape codes and box-drawing characters
function cleanOutput(input: string): string {
  return (
    input
      // ANSI escape codes
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
      // Box-drawing and block characters
      .replace(/[\u2580-\u259F\u2500-\u257F]/gu, "")
      // Clear other terminal UI artifacts
      .replace(/\r/g, "")
      // Collapse multiple empty lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function runCommand(command: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: 1,
        stdout: cleanOutput(stdout),
        stderr: cleanOutput(`${stderr}\n${error.message}`.trim())
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout: cleanOutput(stdout),
        stderr: cleanOutput(stderr)
      });
    });
  });
}

function inferCategory(parsed?: Record<string, unknown>): string | undefined {
  if (!parsed) {
    return undefined;
  }

  const category =
    parsed.category ??
    parsed.issue_type ??
    parsed.type ??
    (typeof parsed.result === "object" && parsed.result !== null && "category" in parsed.result
      ? (parsed.result as Record<string, unknown>).category
      : undefined);

  if (typeof category === "string") {
    return category;
  }

  return undefined;
}

function summarize(output: string, fallback: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return fallback;
  }

  return lines.slice(0, 3).join(" | ");
}

export async function runDoctorDiagnose(timeoutMs = 60_000): Promise<DoctorReport> {
  const result = await runCommand(DIAGNOSE_COMMAND, timeoutMs);

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed,
    summary: summarize(result.stdout, "doctor did not return structured output"),
    category: inferCategory(parsed)
  };
}

export async function runDoctorFix(timeoutMs = 120_000): Promise<DoctorReport> {
  const result = await runCommand(FIX_COMMAND, timeoutMs);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    summary: summarize(result.stdout, "doctor --fix produced no stdout")
  };
}
