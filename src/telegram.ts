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

export class TelegramApprovalBot {
  private readonly enabled: boolean;
  private readonly botToken: string;
  private readonly baseUrl: string;
  private lastUpdateId = 0;
  private approverChatId?: number;
  private pollTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, ApprovalRequest>();

  constructor(enabled: boolean, botToken: string) {
    this.enabled = enabled;
    this.botToken = botToken;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  start(): void {
    if (!this.enabled) {
      logger.warn("Telegram approvals disabled. Fix actions will never run.");
      return;
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

    const updates = (response.result ?? []) as TelegramUpdate[];

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
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`telegram ${method} failed: HTTP ${response.status} ${body}`);
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: Record<string, unknown> | Array<Record<string, unknown>>;
      description?: string;
    };

    if (!data.ok) {
      throw new Error(`telegram ${method} failed: ${data.description ?? "unknown error"}`);
    }

    return data as unknown as Record<string, unknown>;
  }
}
