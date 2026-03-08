import fs from "node:fs/promises";
import path from "node:path";
import { FixHistoryRecord } from "./types.js";
import { getStateDir } from "./paths.js";

const STATE_DIR = getStateDir();
const HISTORY_JSONL_PATH = path.join(STATE_DIR, "fix-history.jsonl");

function markdownEscape(input: string): string {
  return input.replace(/\|/g, "\\|");
}

function toMarkdown(record: FixHistoryRecord): string {
  const procedureLines = record.fix_procedure.length
    ? record.fix_procedure.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "1. (none)";

  const evidenceLines = [
    `- process_running: ${record.evidence.process_running}`,
    `- health_ok: ${record.evidence.health_ok}`,
    `- health_status_code: ${record.evidence.health_status_code ?? "n/a"}`,
    `- health_error: ${record.evidence.health_error ?? "n/a"}`,
    `- log_patterns: ${record.evidence.log_patterns.join(", ") || "n/a"}`,
    `- doctor_summary: ${record.evidence.doctor_summary ?? "n/a"}`,
    `- decision: ${record.evidence.decision?.decision ?? "n/a"}`,
    `- approval: ${record.evidence.approval ?? "n/a"}`,
    `- fix_summary: ${record.evidence.fix_summary ?? "n/a"}`
  ].join("\n");

  return [
    `## ${markdownEscape(record.incident_id)}`,
    `- when_started_iso: ${record.when_started_iso}`,
    `- when_ended_iso: ${record.when_ended_iso}`,
    `- final_result: ${markdownEscape(record.final_result)}`,
    "",
    "### What happened",
    markdownEscape(record.what_happened),
    "",
    "### Fix procedure",
    procedureLines,
    "",
    "### Evidence",
    evidenceLines,
    ""
  ].join("\n");
}

export async function appendFixHistory(record: FixHistoryRecord): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.appendFile(HISTORY_JSONL_PATH, `${JSON.stringify(record)}\n`, "utf8");

  const markdownPath = path.join(STATE_DIR, "fix-history.md");
  await fs.appendFile(markdownPath, `${toMarkdown(record)}\n`, "utf8");
}

export async function loadRecentFixHistory(limit = 5): Promise<FixHistoryRecord[]> {
  try {
    const raw = await fs.readFile(HISTORY_JSONL_PATH, "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as FixHistoryRecord;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is FixHistoryRecord => entry !== undefined);

    return entries.slice(-limit);
  } catch {
    return [];
  }
}
