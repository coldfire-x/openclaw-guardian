import { runDoctorDiagnose, runDoctorFix } from "./doctor.js";
import { appendFixHistory } from "./history.js";
import { logger } from "./logger.js";
import { decideFixAction } from "./pi-decision.js";
import { probeHealth } from "./probes/health.js";
import { probeLogs } from "./probes/logs.js";
import { probeProcess } from "./probes/process.js";
import { StateStore } from "./state-store.js";
import { TelegramApprovalBot } from "./telegram.js";
import { DoctorReport, FixHistoryRecord, GuardianConfig, GuardianState, ProbeSnapshot } from "./types.js";

const INCIDENT_COOLDOWN_MS = 10 * 60 * 1000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_INTERVAL_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function newIncidentId(): string {
  return `inc-${Date.now()}`;
}

function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

export class Guardian {
  private state!: GuardianState;

  constructor(
    private readonly config: GuardianConfig,
    private readonly stateStore: StateStore,
    private readonly telegram: TelegramApprovalBot
  ) {}

  private async saveState(): Promise<void> {
    // Reload current state from disk to preserve fields managed by other components (e.g., telegramChatId)
    const current = await this.stateStore.load();
    // Merge our managed fields into the current state
    const merged: GuardianState = {
      ...current,
      status: this.state.status,
      consecutiveMissingProcessCount: this.state.consecutiveMissingProcessCount,
      healthyStreak: this.state.healthyStreak,
      currentIncidentId: this.state.currentIncidentId,
      lastIncidentStartedAt: this.state.lastIncidentStartedAt,
      lastIncidentResolvedAt: this.state.lastIncidentResolvedAt,
      lastError: this.state.lastError
    };
    await this.stateStore.save(merged);
  }

  async start(): Promise<void> {
    this.state = await this.stateStore.load();
    this.telegram.start();

    logger.info("openclaw-guardian started");

    for (;;) {
      await this.tick();
      await sleep(this.config.openclaw.check_interval_sec * 1000);
    }
  }

  private async tick(): Promise<void> {
    const snapshot = await this.collectSnapshot();

    if (snapshot.processRunning) {
      await this.onProcessRunning(snapshot);
      return;
    }

    await this.onProcessMissing(snapshot);
  }

  private async collectSnapshot(): Promise<ProbeSnapshot> {
    const processProbe = await probeProcess(this.config.openclaw.process_name);

    const url = `http://${this.config.openclaw.host}:${this.config.openclaw.port}${this.config.openclaw.health_path}`;
    const healthProbe = processProbe.running
      ? await probeHealth(url, Math.max(1_000, this.config.llm.timeout_sec * 1000))
      : { ok: false, statusCode: undefined, error: "process_not_running" };

    const logProbe = await probeLogs(this.config.openclaw.log_path);

    return {
      processRunning: processProbe.running,
      matchedProcesses: processProbe.matches,
      healthOk: healthProbe.ok,
      healthStatusCode: healthProbe.statusCode,
      healthError: healthProbe.error,
      logPatterns: logProbe.matchedPatterns,
      logTail: logProbe.tail,
      checkedAtIso: new Date().toISOString()
    };
  }

  private async onProcessRunning(snapshot: ProbeSnapshot): Promise<void> {
    this.state.consecutiveMissingProcessCount = 0;

    if (this.state.status === "VERIFYING") {
      if (snapshot.healthOk) {
        this.state.healthyStreak += 1;
      } else {
        this.state.healthyStreak = 0;
      }

      if (this.state.healthyStreak >= VERIFY_ATTEMPTS) {
        this.state.status = "HEALTHY";
        this.state.currentIncidentId = undefined;
        this.state.lastIncidentResolvedAt = new Date().toISOString();
        await this.telegram.notify("OpenClaw gateway recovered and verified healthy.");
      }
    } else if (this.state.status !== "HEALTHY") {
      this.state.status = "HEALTHY";
      this.state.healthyStreak = snapshot.healthOk ? 1 : 0;
      this.state.currentIncidentId = undefined;
      this.state.lastIncidentResolvedAt = new Date().toISOString();
    }

    await this.saveState();
  }

  private async onProcessMissing(snapshot: ProbeSnapshot): Promise<void> {
    this.state.consecutiveMissingProcessCount += 1;

    if (this.state.consecutiveMissingProcessCount < this.config.openclaw.down_threshold) {
      this.state.status = "SUSPECTED_DOWN";
      await this.saveState();
      logger.warn(
        `gateway process missing (${this.state.consecutiveMissingProcessCount}/${this.config.openclaw.down_threshold})`
      );
      return;
    }

    this.state.status = "CONFIRMED_DOWN";
    await this.saveState();

    if (this.state.currentIncidentId) {
      logger.warn(`incident ${this.state.currentIncidentId} still active; waiting`);
      return;
    }

    if (this.inCooldown()) {
      logger.warn("incident cooldown active; skipping new diagnosis");
      return;
    }

    await this.runIncident(snapshot);
  }

  private inCooldown(): boolean {
    if (!this.state.lastIncidentStartedAt) {
      return false;
    }

    const last = new Date(this.state.lastIncidentStartedAt).getTime();
    return Date.now() - last < INCIDENT_COOLDOWN_MS;
  }

  private async runIncident(snapshot: ProbeSnapshot): Promise<void> {
    const incidentId = newIncidentId();
    const startedAtIso = new Date().toISOString();
    const history: FixHistoryRecord = {
      incident_id: incidentId,
      when_started_iso: startedAtIso,
      when_ended_iso: startedAtIso,
      what_happened: `Gateway process '${this.config.openclaw.process_name}' missing for ${this.state.consecutiveMissingProcessCount} consecutive checks (${this.config.openclaw.check_interval_sec}s interval).`,
      fix_procedure: [
        "Detect confirmed DOWN state after consecutive process-missing checks.",
        "Run openclaw doctor.",
        "Analyze diagnosis using built-in doc-first PI skill with live official docs.",
        "Request Telegram confirmation before any fix action."
      ],
      evidence: {
        process_running: snapshot.processRunning,
        matched_processes: snapshot.matchedProcesses,
        health_ok: snapshot.healthOk,
        health_status_code: snapshot.healthStatusCode,
        health_error: snapshot.healthError,
        log_patterns: snapshot.logPatterns,
        log_excerpt: excerpt(snapshot.logTail, 3_000)
      },
      final_result: "pending"
    };

    const finalizeHistory = async (finalResult: string): Promise<void> => {
      history.final_result = finalResult;
      history.when_ended_iso = new Date().toISOString();
      await appendFixHistory(history);
    };

    try {
      this.state.currentIncidentId = incidentId;
      this.state.lastIncidentStartedAt = startedAtIso;
      this.state.status = "DIAGNOSING";
      await this.saveState();

      await this.telegram.notify(`OpenClaw gateway is confirmed down. Incident: ${incidentId}`);

      const doctorReport = await this.safeDiagnose();
      history.evidence.doctor_summary = doctorReport.summary;
      history.evidence.doctor_stdout_excerpt = excerpt(doctorReport.stdout, 4_000);
      history.evidence.doctor_stderr_excerpt = excerpt(doctorReport.stderr, 2_000);

      const decision = await decideFixAction(this.config, doctorReport, snapshot);
      history.evidence.decision = decision;
      history.fix_procedure.push(`Decision output: ${decision.decision}`);

      this.state.status = "AWAITING_CONFIRMATION";
      await this.saveState();

      const approval = await this.telegram.requestApproval(incidentId, decision, doctorReport.summary);
      history.evidence.approval = approval.reason;
      history.fix_procedure.push(`Telegram approval result: ${approval.reason}`);

      if (!approval.approved) {
        this.state.status = "ESCALATED";
        this.state.lastError = `approval denied: ${approval.reason}`;
        this.state.currentIncidentId = undefined;
        await this.saveState();
        await finalizeHistory("escalated_approval_denied");
        logger.warn(`incident ${incidentId} not approved: ${approval.reason}`);
        return;
      }

      if (decision.decision !== "safe_fix") {
        this.state.status = "ESCALATED";
        this.state.lastError = `decision denied fix: ${decision.decision}`;
        this.state.currentIncidentId = undefined;
        await this.saveState();
        await this.telegram.notify(`Incident ${incidentId}: approval received but decision=${decision.decision}; no fix executed.`);
        await finalizeHistory(`escalated_decision_${decision.decision}`);
        return;
      }

      this.state.status = "FIXING";
      await this.saveState();
      history.fix_procedure.push("Run openclaw doctor --fix (user-approved).");

      const fixReport = await runDoctorFix();
      history.evidence.fix_summary = fixReport.summary;
      history.evidence.fix_stdout_excerpt = excerpt(fixReport.stdout, 4_000);
      history.evidence.fix_stderr_excerpt = excerpt(fixReport.stderr, 2_000);

      if (fixReport.exitCode !== 0) {
        this.state.status = "ESCALATED";
        this.state.lastError = `doctor --fix failed: ${fixReport.summary}`;
        this.state.currentIncidentId = undefined;
        await this.saveState();
        await this.telegram.notify(`Incident ${incidentId}: doctor --fix failed. ${fixReport.summary}`);
        await finalizeHistory("escalated_fix_command_failed");
        return;
      }

      this.state.status = "VERIFYING";
      this.state.healthyStreak = 0;
      await this.saveState();
      await this.telegram.notify(`Incident ${incidentId}: fix executed. Verifying health now.`);
      history.fix_procedure.push("Verify gateway health after fix.");

      const verified = await this.verifyRecovery();
      if (!verified) {
        this.state.status = "ESCALATED";
        this.state.lastError = "verification failed after fix";
        this.state.currentIncidentId = undefined;
        await this.saveState();
        await this.telegram.notify(`Incident ${incidentId}: verification failed. Manual intervention required.`);
        await finalizeHistory("escalated_verification_failed");
        return;
      }

      this.state.status = "HEALTHY";
      this.state.currentIncidentId = undefined;
      this.state.lastIncidentResolvedAt = new Date().toISOString();
      await this.saveState();
      await this.telegram.notify(`Incident ${incidentId}: gateway recovered successfully.`);
      await finalizeHistory("resolved_recovered_after_fix");
    } catch (error) {
      history.evidence.internal_error = error instanceof Error ? error.message : String(error);
      await finalizeHistory("escalated_internal_error");
      throw error;
    }
  }

  private async safeDiagnose(): Promise<DoctorReport> {
    try {
      return await runDoctorDiagnose();
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        summary: "doctor diagnose execution error"
      };
    }
  }

  private async verifyRecovery(): Promise<boolean> {
    let healthyChecks = 0;

    for (let i = 0; i < VERIFY_ATTEMPTS; i += 1) {
      await sleep(VERIFY_INTERVAL_MS);

      const processProbe = await probeProcess(this.config.openclaw.process_name);
      if (!processProbe.running) {
        healthyChecks = 0;
        continue;
      }

      const url = `http://${this.config.openclaw.host}:${this.config.openclaw.port}${this.config.openclaw.health_path}`;
      const healthProbe = await probeHealth(url, Math.max(1_000, this.config.llm.timeout_sec * 1000));

      if (healthProbe.ok) {
        healthyChecks += 1;
      } else {
        healthyChecks = 0;
      }

      if (healthyChecks >= 3) {
        return true;
      }
    }

    return false;
  }
}
