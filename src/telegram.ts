import https from "node:https";
import { URL } from "node:url";
import { ProxyAgent } from "proxy-agent";
import { ApprovalResult, FixDecision } from "./types.js";
import { logger } from "./logger.js";

const POLL_INTERVAL_MS = 2_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

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
  private lastUpdateId = 0;
  private approverChatId?: number;
  private pollTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(enabled: boolean, botToken: string, proxy: string) {
    this.enabled = enabled;
    this.botToken = botToken;
    this.proxy = proxy.trim();
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;

    if (this.proxy) {
      this.proxyAgent = new ProxyAgent(this.proxy);
    }
  }

  start(): void {
    if (!this.enabled) {
      logger.warn("Telegram approvals disabled. Fix actions will never run.");
      return;
    }

    if (this.proxy) {
      logger.info(`Telegram proxy enabled (${this.safeProxyLabel(this.proxy)})`);
    }

    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        logger.error(`Telegram poll error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, POLL_INTERVAL_MS);

    void this.poll();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }

  async notify(text: string): Promise<void> {
    if (!this.enabled || !this.approverChatId) {
      return;
    }

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
      "Approve running: openclaw gateway doctor --fix ?"
    ].join("\n");

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
      timeout: 0,
      offset: this.lastUpdateId + 1
    });

    const updates = Array.isArray(response.result) ? (response.result as TelegramUpdate[]) : [];

    for (const update of updates) {
      this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      await this.handleUpdate(update);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text) {
      const text = update.message.text.trim();
      if (text === "/start" || text === "/bind") {
        this.approverChatId = update.message.chat.id;
        await this.api("sendMessage", {
          chat_id: this.approverChatId,
          text: "openclaw-guardian is bound. You will receive fix approvals here."
        });
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

    const pending = this.pending.get(incidentId);
    if (!pending) {
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

    clearTimeout(pending.timeout);
    this.pending.delete(incidentId);
    pending.resolve(result);

    await this.api("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: result.approved ? "Approved" : "Rejected"
    });
  }

  private async api(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/${method}`);
    const data = await this.postJson(url, payload, method);

    if (!data.ok) {
      throw new Error(`telegram ${method} failed: ${data.description ?? "unknown error"}`);
    }

    return data as unknown as Record<string, unknown>;
  }

  private async postJson(
    url: URL,
    payload: Record<string, unknown>,
    methodName: string
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
          timeout: 15_000
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

  private safeProxyLabel(proxy: string): string {
    try {
      const parsed = new URL(proxy);
      return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      return "invalid-proxy-url";
    }
  }
}
