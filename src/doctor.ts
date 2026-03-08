import { spawn } from "node:child_process";
import { DoctorReport } from "./types.js";

const DIAGNOSE_COMMAND = ["openclaw", "gateway", "doctor", "--format", "json"];
const FIX_COMMAND = ["openclaw", "gateway", "doctor", "--fix"];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
        stdout,
        stderr: `${stderr}\n${error.message}`.trim()
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
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
