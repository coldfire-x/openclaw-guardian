import fs from "node:fs/promises";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { DoctorReport, GuardianConfig } from "./types.js";
import { logger } from "./logger.js";

interface DoctorAnalysis {
  summary: string;
  issues_found: string[];
  severity: "critical" | "warning" | "info";
  fix_suggestions: string[];
  auto_fix_recommended: boolean;
  auto_fix_would_help: boolean;
  explanation: string;
}

async function readLogTail(logPath: string, maxBytes = 32 * 1024): Promise<string> {
  try {
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
  } catch {
    return "(could not read log file)";
  }
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

function extractJson(raw: string): Partial<DoctorAnalysis> | null {
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
      return JSON.parse(candidate) as Partial<DoctorAnalysis>;
    } catch {
      // keep scanning
    }
  }

  return null;
}

function normalizeAnalysis(data: Partial<DoctorAnalysis>): DoctorAnalysis {
  const severity = ["critical", "warning", "info"].includes(data.severity as string)
    ? (data.severity as "critical" | "warning" | "info")
    : "info";

  return {
    summary: data.summary?.trim() || "No summary provided",
    issues_found: Array.isArray(data.issues_found)
      ? data.issues_found.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
    severity,
    fix_suggestions: Array.isArray(data.fix_suggestions)
      ? data.fix_suggestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
    auto_fix_recommended: data.auto_fix_recommended === true,
    auto_fix_would_help: data.auto_fix_would_help === true,
    explanation: data.explanation?.trim() || "No explanation provided"
  };
}

function formatAnalysisForTelegram(analysis: DoctorAnalysis): string {
  const lines = [
    `📋 *Analysis Summary*`,
    `Severity: ${analysis.severity.toUpperCase()}`,
    "",
    analysis.summary,
    ""
  ];

  if (analysis.issues_found.length > 0) {
    lines.push(`🔍 *Issues Found (${analysis.issues_found.length})*:`);
    analysis.issues_found.forEach((issue, i) => lines.push(`${i + 1}. ${issue}`));
    lines.push("");
  }

  if (analysis.fix_suggestions.length > 0) {
    lines.push(`💡 *Fix Suggestions*:`);
    analysis.fix_suggestions.forEach((suggestion, i) => lines.push(`${i + 1}. ${suggestion}`));
    lines.push("");
  }

  lines.push(`🤖 *Auto Fix Recommended*: ${analysis.auto_fix_recommended ? "Yes" : "No"}`);
  if (analysis.auto_fix_would_help) {
    lines.push(`(Auto fix would likely help resolve these issues)`);
  }

  if (analysis.explanation) {
    lines.push("");
    lines.push(`📝 *Explanation*:`);
    lines.push(analysis.explanation);
  }

  return lines.join("\n");
}

export async function analyzeDoctorOutput(
  config: GuardianConfig,
  report: DoctorReport,
  logPath: string
): Promise<{ analysis: DoctorAnalysis; formatted: string }> {
  logger.info("[LLM] Starting doctor output analysis");

  const configuredApiKey = config.llm.api_key.trim();
  const envApiKey = config.llm.api_key_env.trim() ? (process.env[config.llm.api_key_env] ?? "").trim() : "";
  const apiKey = configuredApiKey || envApiKey;

  if (!apiKey) {
    logger.warn("[LLM] No API key configured for analysis");
    return {
      analysis: {
        summary: "LLM API key not configured. Cannot analyze doctor output.",
        issues_found: [],
        severity: "info",
        fix_suggestions: ["Configure llm.api_key in config to enable AI analysis"],
        auto_fix_recommended: false,
        auto_fix_would_help: false,
        explanation: "The analysis feature requires an LLM API key to be configured."
      },
      formatted: "⚠️ LLM API key not configured. Cannot analyze doctor output.\n\nRaw output available in logs."
    };
  }

  logger.info(`[LLM] Reading log tail from: ${logPath}`);
  const logTail = await readLogTail(logPath);
  logger.info(`[LLM] Log tail read: ${logTail.length} chars`);

  logger.info(`[LLM] Using provider: ${config.llm.provider}, model: ${config.llm.model}`);
  const model = getModel(config.llm.provider as never, config.llm.model as never) as any;
  if (config.llm.api_url.trim()) {
    model.baseUrl = config.llm.api_url;
    logger.info(`[LLM] Using custom API URL: ${config.llm.api_url}`);
  }

  const systemPrompt = `You are an expert OpenClaw gateway diagnostician. Analyze the output of "openclaw doctor" command and the recent log entries to provide a structured analysis.

Your task:
1. Identify the main issues from the doctor output
2. Correlate with log entries if relevant
3. Assess severity (critical/warning/info)
4. Suggest specific fixes
5. Recommend whether automatic fix (--fix) would help

Return ONLY valid JSON with this exact structure:
{
  "summary": "Brief summary of the situation",
  "issues_found": ["Issue 1", "Issue 2"],
  "severity": "critical|warning|info",
  "fix_suggestions": ["Suggestion 1", "Suggestion 2"],
  "auto_fix_recommended": true|false,
  "auto_fix_would_help": true|false,
  "explanation": "Detailed explanation of your analysis"
}

Guidelines:
- auto_fix_recommended: true only if the issues are clearly understood and safe to fix automatically
- auto_fix_would_help: true if running "openclaw doctor --fix" would likely resolve the issues
- severity "critical" for gateway-down or data-loss scenarios
- severity "warning" for configuration issues or non-critical errors
- severity "info" for minor suggestions or no real issues`;

  const userPrompt = `Please analyze this OpenClaw doctor output and recent logs:

--- Doctor Exit Code ---
${report.exitCode}

--- Doctor Summary ---
${report.summary}

--- Doctor Stdout ---
${report.stdout.slice(0, 8000)}

--- Doctor Stderr ---
${report.stderr.slice(0, 4000)}

--- Recent Log Tail ---
${logTail.slice(-6000)}

Provide your analysis in the required JSON format.`;

  const agent = new Agent({
    initialState: {
      model,
      systemPrompt
    },
    getApiKey: () => apiKey
  });

  try {
    logger.info("[LLM] Sending prompt to LLM...");
    const promptStartTime = Date.now();
    await agent.prompt(userPrompt);
    const promptDuration = Date.now() - promptStartTime;
    logger.info(`[LLM] Prompt completed in ${promptDuration}ms`);

    const raw = extractAssistantText(agent.state);
    logger.info(`[LLM] Raw response length: ${raw.length} chars`);

    const decoded = extractJson(raw);

    if (!decoded) {
      logger.warn("[LLM] LLM did not return valid JSON analysis");
      logger.info(`[LLM] Raw response preview: ${raw.slice(0, 500)}...`);
      return {
        analysis: {
          summary: "Failed to parse LLM analysis response",
          issues_found: ["LLM response was not valid JSON"],
          severity: "info",
          fix_suggestions: ["Try running the command again", "Check raw doctor output manually"],
          auto_fix_recommended: false,
          auto_fix_would_help: false,
          explanation: "The AI analysis could not be parsed. Raw doctor output is available."
        },
        formatted: "⚠️ AI analysis could not be parsed. Please check the raw output."
      };
    }

    const analysis = normalizeAnalysis(decoded);
    const formatted = formatAnalysisForTelegram(analysis);

    logger.info(`[LLM] Analysis complete: severity=${analysis.severity}, issues=${analysis.issues_found.length}, auto_fix_recommended=${analysis.auto_fix_recommended}`);

    return { analysis, formatted };
  } catch (error) {
    logger.error(`[LLM] Error during LLM analysis: ${error instanceof Error ? error.message : String(error)}`);
    return {
      analysis: {
        summary: "Error during LLM analysis",
        issues_found: [error instanceof Error ? error.message : "Unknown error"],
        severity: "info",
        fix_suggestions: ["Check LLM configuration", "Try again later"],
        auto_fix_recommended: false,
        auto_fix_would_help: false,
        explanation: "An error occurred while analyzing the doctor output with AI."
      },
      formatted: `⚠️ Error during AI analysis: ${error instanceof Error ? error.message : "Unknown error"}`
    };
  }
}
