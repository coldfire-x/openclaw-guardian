import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { DoctorReport, FixDecision, GuardianConfig, ProbeSnapshot } from "./types.js";
import { loadRecentFixHistory } from "./history.js";

const BUILTIN_SKILL_PATH = path.resolve(process.cwd(), "skills/openclaw-doc-first-fix/SKILL.md");
const DOCS_DIR = path.resolve(process.cwd(), "references/openclaw-docs");
const DOC_FILES = ["README.md", "gateway-doctor.md", "gateway-recovery.md"];
const OFFICIAL_DOC_URLS = [
  "https://docs.openclaw.ai/",
  "https://docs.openclaw.ai/gateway/doctor",
  "https://docs.openclaw.ai/gateway/recovery"
];
const MAX_DOC_CHARS = 8_000;

function normalizeDecision(data: Partial<FixDecision>): FixDecision {
  const decision = data.decision === "safe_fix" || data.decision === "unsafe" ? data.decision : "manual_only";
  const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "model did not provide a valid reason";
  const confidenceRaw = typeof data.confidence === "number" ? data.confidence : 0;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));
  const recommendedActions = Array.isArray(data.recommended_actions)
    ? data.recommended_actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const docReferences = Array.isArray(data.doc_references)
    ? data.doc_references.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const hasOfficialReference = docReferences.some((reference) => reference.includes("docs.openclaw.ai"));

  if (decision === "safe_fix" && docReferences.length === 0) {
    return {
      decision: "manual_only",
      reason: "safe_fix denied because no OpenClaw documentation reference was provided",
      confidence,
      recommended_actions: recommendedActions,
      doc_references: docReferences
    };
  }

  if (decision === "safe_fix" && !hasOfficialReference) {
    return {
      decision: "manual_only",
      reason: "safe_fix denied because no official docs.openclaw.ai reference was provided",
      confidence,
      recommended_actions: recommendedActions,
      doc_references: docReferences
    };
  }

  return {
    decision,
    reason,
    confidence,
    recommended_actions: recommendedActions,
    doc_references: docReferences
  };
}

function extractJson(raw: string): Partial<FixDecision> | null {
  const direct = raw.trim();
  if (!direct) {
    return null;
  }

  const candidates = [direct];
  const match = direct.match(/\{[\s\S]*\}/);
  if (match) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as Partial<FixDecision>;
    } catch {
      // keep scanning
    }
  }

  return null;
}

async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function loadSkillAndDocs(): Promise<{ skillText: string; docsText: string }> {
  const skillText = await readIfExists(BUILTIN_SKILL_PATH);

  const docsParts: string[] = [];
  for (const fileName of DOC_FILES) {
    const content = await readIfExists(path.join(DOCS_DIR, fileName));
    if (content.trim()) {
      docsParts.push(`# ${fileName}\n${content.trim()}`);
    }
  }

  return {
    skillText,
    docsText: docsParts.join("\n\n")
  };
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOfficialDoc(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return `URL: ${url}\nHTTP error: ${response.status}`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const text = contentType.includes("text/html") ? stripHtml(raw) : raw;
    return `URL: ${url}\n${text.slice(0, MAX_DOC_CHARS)}`;
  } catch (error) {
    return `URL: ${url}\nFetch error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadOfficialDocsLive(): Promise<string> {
  const entries = await Promise.all(OFFICIAL_DOC_URLS.map((url) => fetchOfficialDoc(url)));
  return entries.join("\n\n");
}

function formatRecentHistoryForPrompt(): Promise<string> {
  return loadRecentFixHistory(5).then((entries) => {
    if (entries.length === 0) {
      return "(no previous fix history)";
    }

    return entries
      .map((entry) =>
        JSON.stringify(
          {
            when_started_iso: entry.when_started_iso,
            when_ended_iso: entry.when_ended_iso,
            what_happened: entry.what_happened,
            final_result: entry.final_result,
            decision: entry.evidence.decision?.decision,
            approval: entry.evidence.approval
          },
          null,
          2
        )
      )
      .join("\n\n");
  });
}

function extractAssistantText(state: unknown): string {
  if (typeof state !== "object" || state === null) {
    return "";
  }

  const maybeMessages = (state as { messages?: unknown[] }).messages;
  if (!Array.isArray(maybeMessages) || maybeMessages.length === 0) {
    return "";
  }

  const lastMessage = maybeMessages[maybeMessages.length - 1] as {
    role?: string;
    content?: unknown;
  };

  if (lastMessage.role !== "assistant") {
    return "";
  }

  if (typeof lastMessage.content === "string") {
    return lastMessage.content;
  }

  if (Array.isArray(lastMessage.content)) {
    const textParts = lastMessage.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part === "object" && part !== null && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter((text) => text.length > 0);

    return textParts.join("\n");
  }

  return "";
}

function modelPrompt(report: DoctorReport, snapshot: ProbeSnapshot): string {
  return [
    "Analyze OpenClaw gateway recovery options.",
    "Use only the provided doctor output, logs, and documentation excerpts.",
    "Return strict JSON with this schema:",
    '{"decision":"safe_fix|manual_only|unsafe","reason":"...","confidence":0.0,"recommended_actions":["..."],"doc_references":["https://docs.openclaw.ai/path#section"]}',
    "If there is any uncertainty, return manual_only.",
    "A safe_fix decision must include at least one docs.openclaw.ai reference.",
    "Never recommend automatic action without explicit user confirmation.",
    "--- doctor summary ---",
    report.summary,
    "--- doctor stdout ---",
    report.stdout.slice(0, 6000),
    "--- doctor stderr ---",
    report.stderr.slice(0, 2000),
    "--- process probe ---",
    JSON.stringify({
      processRunning: snapshot.processRunning,
      matchedProcesses: snapshot.matchedProcesses,
      healthOk: snapshot.healthOk,
      healthStatusCode: snapshot.healthStatusCode,
      healthError: snapshot.healthError,
      logPatterns: snapshot.logPatterns
    }),
    "--- log tail ---",
    snapshot.logTail.slice(-6000)
  ].join("\n");
}

export async function decideFixAction(config: GuardianConfig, report: DoctorReport, snapshot: ProbeSnapshot): Promise<FixDecision> {
  const configuredApiKey = config.llm.api_key.trim();
  const envApiKey = config.llm.api_key_env.trim() ? (process.env[config.llm.api_key_env] ?? "").trim() : "";
  const apiKey = configuredApiKey || envApiKey;

  if (!apiKey) {
    const envHint = config.llm.api_key_env.trim()
      ? ` or set env var ${config.llm.api_key_env}`
      : "";
    return {
      decision: "manual_only",
      reason: `missing LLM API key: set llm.api_key in config${envHint}`,
      confidence: 0,
      recommended_actions: ["Set API key and retry diagnosis"],
      doc_references: []
    };
  }

  const [localDocs, officialDocsLive, recentHistoryText] = await Promise.all([
    loadSkillAndDocs(),
    loadOfficialDocsLive(),
    formatRecentHistoryForPrompt()
  ]);

  const model = getModel(config.llm.provider as never, config.llm.model as never) as any;

  if (config.llm.api_url.trim()) {
    model.baseUrl = config.llm.api_url;
  }

  const systemPrompt = [
    "You are openclaw-guardian diagnosis assistant.",
    "Follow the built-in skill instructions exactly.",
    "Official docs are fetched live for each diagnosis and must not be cached.",
    "Never return markdown.",
    "Always return JSON only.",
    "Built-in skill:",
    localDocs.skillText || "(skill file missing)",
    "Local OpenClaw documentation excerpts:",
    localDocs.docsText || "(docs snapshot missing)",
    "Live official OpenClaw documentation excerpts (fetched now, no cache):",
    officialDocsLive,
    "Recent fix history (for reference):",
    recentHistoryText
  ].join("\n\n");

  const agent = new Agent({
    initialState: {
      model,
      systemPrompt
    },
    getApiKey: () => apiKey
  });

  await agent.prompt(modelPrompt(report, snapshot));

  const raw = extractAssistantText(agent.state);
  const decoded = extractJson(raw);

  if (!decoded) {
    return {
      decision: "manual_only",
      reason: "model output was not valid JSON",
      confidence: 0,
      recommended_actions: ["Review doctor output manually"],
      doc_references: []
    };
  }

  return normalizeDecision(decoded);
}
