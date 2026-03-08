import https from "node:https";
import { URL } from "node:url";
import { ProxyAgent } from "proxy-agent";
import { ApprovalResult, FixDecision, GuardianConfig } from "./types.js";
import { logger } from "./logger.js";
import { StateStore } from "./state-store.js";
import { restartGateway } from "./gateway.js";
import { runDoctorDiagnose, runDoctorFix } from "./doctor.js";
import { analyzeDoctorOutput } from "./doctor-analyzer.js";

const POLL_INTERVAL_MS = 2_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const TELEGRAM_POLL_TIMEOUT_SEC = 25;
const TELEGRAM_POLL_HTTP_TIMEOUT_MS = 35_000;

interface ApprovalRequest {
  resolve: (value: ApprovalResult) => void;
  timeout: NodeJS.Timeout;
}

interface TelegramMessage {
  message_id: number;
  chat: {
    id: number;
    type: string;
  };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from: {
    id: number;
  };
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

export class TelegramApprovalBot {
  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly proxy: string;
  private readonly baseUrl: string;
  private readonly proxyAgent?: ProxyAgent;
  private readonly processName: string;
  private readonly logPath: string;
  private lastUpdateId = 0;
  private approverChatId?: number;
  private pollLoop?: Promise<void>;
  private stopping = false;
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(
    enabled: boolean,
    botToken: string,
    proxy: string,
    private readonly stateStore: StateStore,
    processName: string,
    logPath: string,
    private readonly config: GuardianConfig
  ) {
    this.enabled = enabled;
    this.botToken = botToken;
    this.proxy = proxy.trim();
    this.processName = processName;
    this.logPath = logPath;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;

    if (this.proxy) {
      this.proxyAgent = new ProxyAgent({
        getProxyForUrl: () => this.proxy
      });
    }
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.warn("Telegram approvals disabled. Fix actions will never run.");
      return;
    }

    if (this.pollLoop) {
      return;
    }

    // Restore chat ID from persisted state
    const state = await this.stateStore.load();
    if (state.telegramChatId) {
      this.approverChatId = state.telegramChatId;
      logger.info(`Telegram bound to chat ID: ${this.approverChatId}`);
    }

    if (this.proxy) {
      logger.info(`Telegram proxy enabled (${this.safeProxyLabel(this.proxy)})`);
    }

    this.stopping = false;
    this.pollLoop = this.runPollLoop();
  }

  stop(): void {
    this.stopping = true;
  }

  async notify(text: string): Promise<void> {
    if (!this.enabled || !this.approverChatId) {
      return;
    }

    logger.info(`[TG] Sending notification: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
    await this.api("sendMessage", {
      chat_id: this.approverChatId,
      text
    });
  }

  async requestApproval(
    incidentId: string,
    decision: FixDecision,
    doctorSummary: string
  ): Promise<ApprovalResult> {
    if (!this.enabled) {
      return {
        approved: false,
        reason: "telegram_disabled"
      };
    }

    if (!this.approverChatId) {
      return {
        approved: false,
        reason: "telegram_not_bound: send /bind to the bot first"
      };
    }

    const text = [
      `OpenClaw incident: ${incidentId}`,
      `Decision: ${decision.decision}`,
      `Reason: ${decision.reason}`,
      `Doctor: ${doctorSummary}`,
      "Approve running: openclaw doctor --fix ?"
    ].join("\n");

    logger.info(`[TG] Requesting approval for incident ${incidentId} (decision: ${decision.decision})`);
    await this.api("sendMessage", {
      chat_id: this.approverChatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Approve",
              callback_data: `approve:${incidentId}`
            },
            {
              text: "Reject",
              callback_data: `reject:${incidentId}`
            }
          ]
        ]
      }
    });

    return await new Promise<ApprovalResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(incidentId);
        logger.info(`[TG] Approval timeout for incident ${incidentId}`);
        resolve({
          approved: false,
          reason: "approval_timeout"
        });
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(incidentId, { resolve, timeout });
    });
  }

  private async poll(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const response = await this.api("getUpdates", {
      timeout: TELEGRAM_POLL_TIMEOUT_SEC,
      offset: this.lastUpdateId + 1
    }, TELEGRAM_POLL_HTTP_TIMEOUT_MS);

    const updates = Array.isArray(response.result) ? (response.result as TelegramUpdate[]) : [];

    for (const update of updates) {
      this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      await this.handleUpdate(update);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text) {
      const text = update.message.text.trim();
      const chatId = update.message.chat.id;

      logger.info(`[TG] Received command: ${text} from chat ${chatId}`);

      if (text === "/start" || text === "/bind") {
        this.approverChatId = chatId;
        // Persist chat ID to state
        const state = await this.stateStore.load();
        state.telegramChatId = this.approverChatId;
        await this.stateStore.save(state);
        logger.info(`[TG] Bound to chat ID: ${chatId}`);
        await this.api("sendMessage", {
          chat_id: this.approverChatId,
          text: "openclaw-guardian is bound. You will receive fix approvals here.\n\nCommands:\n/restart-gateway - Restart the OpenClaw gateway\n/doctor - Run 'openclaw doctor'\n/doctor-fix - Run 'openclaw doctor --fix'"
        });
        return;
      }

      if (text === "/restart-gateway") {
        if (!this.enabled) {
          await this.api("sendMessage", {
            chat_id: chatId,
            text: "Telegram bot is disabled."
          });
          return;
        }

        logger.info("[TG] Executing /restart-gateway command");
        await this.api("sendMessage", {
          chat_id: chatId,
          text: "Restarting OpenClaw gateway..."
        });

        const result = await restartGateway(this.processName, this.logPath);

        const logSection = result.logLines ? `\n\nLast 10 log lines:\n\`\`\`\n${result.logLines}\n\`\`\`` : "";

        await this.api("sendMessage", {
          chat_id: chatId,
          text: `Gateway restart result:\nPrevious state: ${result.previousState}\nSuccess: ${result.success}\nMessage: ${result.message}${logSection}`
        });
        logger.info(`[TG] /restart-gateway completed: success=${result.success}`);
        return;
      }

      if (text === "/doctor") {
        logger.info("[TG] Executing /doctor command");
        await this.api("sendMessage", {
          chat_id: chatId,
          text: "Running 'openclaw doctor --yes' and analyzing with AI..."
        });

        const report = await runDoctorDiagnose();
        logger.info(`[TG] Doctor completed, analyzing with LLM...`);

        await this.api("sendMessage", {
          chat_id: chatId,
          text: "🤖 AI is analyzing the output and logs..."
        });

        const { formatted } = await analyzeDoctorOutput(this.config, report, this.logPath);

        await this.api("sendMessage", {
          chat_id: chatId,
          text: formatted,
          parse_mode: "Markdown"
        });
        logger.info(`[TG] /doctor completed: exitCode=${report.exitCode}`);
        return;
      }

      if (text === "/doctor-fix") {
        logger.info("[TG] Executing /doctor-fix command");
        await this.api("sendMessage", {
          chat_id: chatId,
          text: "Running 'openclaw doctor --fix --non-interactive' and analyzing with AI..."
        });

        const report = await runDoctorFix();
        logger.info(`[TG] Doctor fix completed, analyzing with LLM...`);

        await this.api("sendMessage", {
          chat_id: chatId,
          text: "🤖 AI is analyzing the fix results and logs..."
        });

        const { formatted } = await analyzeDoctorOutput(this.config, report, this.logPath);

        await this.api("sendMessage", {
          chat_id: chatId,
          text: formatted,
          parse_mode: "Markdown"
        });
        logger.info(`[TG] /doctor-fix completed: exitCode=${report.exitCode}`);
        return;
      }

      return;
    }

    const callback = update.callback_query;
    if (!callback?.data) {
      return;
    }

    const [action, incidentId] = callback.data.split(":");
    if (!incidentId) {
      return;
    }

    logger.info(`[TG] Received callback: ${action} for incident ${incidentId}`);

    const pending = this.pending.get(incidentId);
    if (!pending) {
      logger.warn(`[TG] No pending approval for incident ${incidentId}`);
      await this.api("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "This approval is no longer active."
      });
      return;
    }

    const result: ApprovalResult = {
      approved: action === "approve",
      reason: action === "approve" ? "approved_by_user" : "rejected_by_user"
    };

    logger.info(`[TG] Approval ${result.approved ? "granted" : "denied"} for incident ${incidentId}`);

    clearTimeout(pending.timeout);
    this.pending.delete(incidentId);
    pending.resolve(result);

    await this.api("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: result.approved ? "Approved" : "Rejected"
    });
  }

  private async api(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs = 15_000
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/${method}`);
    const data = await this.postJson(url, payload, method, timeoutMs);

    if (!data.ok) {
      throw new Error(`telegram ${method} failed: ${data.description ?? "unknown error"}`);
    }

    return data as unknown as Record<string, unknown>;
  }

  private async postJson(
    url: URL,
    payload: Record<string, unknown>,
    methodName: string,
    timeoutMs: number
  ): Promise<TelegramApiResponse> {
    const body = JSON.stringify(payload);

    return await new Promise<TelegramApiResponse>((resolve, reject) => {
      const request = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port ? Number(url.port) : undefined,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body).toString()
          },
          agent: this.proxyAgent,
          timeout: timeoutMs
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });

          response.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");

            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`telegram ${methodName} failed: HTTP ${response.statusCode ?? "unknown"} ${raw}`));
              return;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              reject(new Error(`telegram ${methodName} failed: non-json response ${raw.slice(0, 400)}`));
              return;
            }

            if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
              reject(new Error(`telegram ${methodName} failed: malformed response`));
              return;
            }

            resolve(parsed as TelegramApiResponse);
          });
        }
      );

      request.on("timeout", () => {
        request.destroy(new Error(`telegram ${methodName} timeout`));
      });
      request.on("error", (error) => {
        reject(error);
      });
      request.write(body);
      request.end();
    });
  }

  private async runPollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.poll();
      } catch (error) {
        logger.error(`[TG] Poll error: ${error instanceof Error ? error.message : String(error)}`);
        await this.delay(POLL_INTERVAL_MS);
      }
    }

    this.pollLoop = undefined;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private safeProxyLabel(proxy: string): string {
    try {
      const parsed = new URL(proxy);
      return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      return "invalid-proxy-url";
    }
  }
}
