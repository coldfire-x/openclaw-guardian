import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { GuardianConfig } from "./types.js";

const DEFAULT_CONFIG: GuardianConfig = {
  openclaw: {
    host: "127.0.0.1",
    port: 18789,
    health_path: "/healthz",
    process_name: "openclaw-gateway",
    log_path: "/var/log/openclaw/gateway.log",
    check_interval_sec: 60,
    down_threshold: 3
  },
  telegram: {
    enabled: true,
    bot_token: ""
  },
  llm: {
    provider: "openai",
    api_url: "https://api.openai.com/v1",
    api_key: "",
    api_key_env: "OPENCLAW_GUARDIAN_LLM_API_KEY",
    model: "gpt-4.1-mini",
    timeout_sec: 30
  }
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function mergeConfig(base: GuardianConfig, input: unknown): GuardianConfig {
  if (!isObject(input)) {
    return base;
  }

  const merged = structuredClone(base);

  if (isObject(input.openclaw)) {
    merged.openclaw = {
      host: readString(input.openclaw.host, merged.openclaw.host),
      port: readNumber(input.openclaw.port, merged.openclaw.port),
      health_path: readString(input.openclaw.health_path, merged.openclaw.health_path),
      process_name: readString(input.openclaw.process_name, merged.openclaw.process_name),
      log_path: readString(input.openclaw.log_path, merged.openclaw.log_path),
      check_interval_sec: readNumber(input.openclaw.check_interval_sec, merged.openclaw.check_interval_sec),
      down_threshold: readNumber(input.openclaw.down_threshold, merged.openclaw.down_threshold)
    };
  }

  if (isObject(input.telegram)) {
    merged.telegram = {
      enabled: readBoolean(input.telegram.enabled, merged.telegram.enabled),
      bot_token: readString(input.telegram.bot_token, merged.telegram.bot_token)
    };
  }

  if (isObject(input.llm)) {
    merged.llm = {
      provider: readString(input.llm.provider, merged.llm.provider),
      api_url: readString(input.llm.api_url, merged.llm.api_url),
      api_key: readString(input.llm.api_key, merged.llm.api_key),
      api_key_env: readString(input.llm.api_key_env, merged.llm.api_key_env),
      model: readString(input.llm.model, merged.llm.model),
      timeout_sec: readNumber(input.llm.timeout_sec, merged.llm.timeout_sec)
    };
  }

  return merged;
}

function assertConfig(config: GuardianConfig): void {
  if (!config.openclaw.log_path.trim()) {
    throw new Error("openclaw.log_path is required");
  }

  if (config.openclaw.port <= 0) {
    throw new Error("openclaw.port must be positive");
  }

  if (config.openclaw.check_interval_sec <= 0) {
    throw new Error("openclaw.check_interval_sec must be positive");
  }

  if (config.openclaw.down_threshold < 1) {
    throw new Error("openclaw.down_threshold must be >= 1");
  }

  if (config.telegram.enabled && !config.telegram.bot_token.trim()) {
    throw new Error("telegram.bot_token is required when telegram.enabled=true");
  }

  if (!config.llm.provider.trim()) {
    throw new Error("llm.provider is required");
  }

  if (!config.llm.model.trim()) {
    throw new Error("llm.model is required");
  }
}

export function resolveConfigPath(inputPath?: string): string {
  if (inputPath) {
    return path.resolve(process.cwd(), inputPath);
  }

  return path.resolve(process.cwd(), "config/config.yaml");
}

export function loadConfig(configPath: string): GuardianConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw);
  const merged = mergeConfig(DEFAULT_CONFIG, parsed);

  assertConfig(merged);
  return merged;
}

export { DEFAULT_CONFIG };
