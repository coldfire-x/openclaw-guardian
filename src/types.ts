export interface OpenClawConfig {
  host: string;
  port: number;
  health_path: string;
  process_name: string;
  log_path: string;
  check_interval_sec: number;
  down_threshold: number;
}

export interface TelegramConfig {
  enabled: boolean;
  bot_token: string;
  proxy: string;
}

export interface LlmConfig {
  provider: string;
  api_url: string;
  api_key: string;
  api_key_env: string;
  model: string;
  timeout_sec: number;
}

export interface GuardianConfig {
  openclaw: OpenClawConfig;
  telegram: TelegramConfig;
  llm: LlmConfig;
}

export type GuardianStatus =
  | "HEALTHY"
  | "SUSPECTED_DOWN"
  | "CONFIRMED_DOWN"
  | "DIAGNOSING"
  | "AWAITING_CONFIRMATION"
  | "FIXING"
  | "VERIFYING"
  | "ESCALATED";

export interface ProbeSnapshot {
  processRunning: boolean;
  matchedProcesses: Array<{
    pid: number;
    name: string;
    cmd?: string;
  }>;
  healthOk: boolean;
  healthStatusCode?: number;
  healthError?: string;
  logPatterns: string[];
  logTail: string;
  checkedAtIso: string;
}

export interface DoctorReport {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed?: Record<string, unknown>;
  summary: string;
  category?: string;
}

export type FixDecisionKind = "safe_fix" | "manual_only" | "unsafe";

export interface FixDecision {
  decision: FixDecisionKind;
  reason: string;
  confidence: number;
  recommended_actions: string[];
  doc_references: string[];
}

export interface GuardianState {
  status: GuardianStatus;
  consecutiveMissingProcessCount: number;
  healthyStreak: number;
  telegramChatId?: number;
  currentIncidentId?: string;
  lastIncidentStartedAt?: string;
  lastIncidentResolvedAt?: string;
  lastError?: string;
}

export interface ApprovalResult {
  approved: boolean;
  reason: string;
}

export interface FixHistoryRecord {
  incident_id: string;
  when_started_iso: string;
  when_ended_iso: string;
  what_happened: string;
  fix_procedure: string[];
  evidence: {
    process_running: boolean;
    matched_processes: Array<{
      pid: number;
      name: string;
      cmd?: string;
    }>;
    health_ok: boolean;
    health_status_code?: number;
    health_error?: string;
    log_patterns: string[];
    log_excerpt: string;
    doctor_summary?: string;
    doctor_stdout_excerpt?: string;
    doctor_stderr_excerpt?: string;
    decision?: FixDecision;
    approval?: string;
    fix_summary?: string;
    fix_stdout_excerpt?: string;
    fix_stderr_excerpt?: string;
    internal_error?: string;
  };
  final_result: string;
}
