#!/usr/bin/env node
import { loadConfig, resolveConfigPath } from "./config.js";
import { Guardian } from "./guardian.js";
import { logger } from "./logger.js";
import { StateStore } from "./state-store.js";
import { TelegramApprovalBot } from "./telegram.js";

function parseConfigArg(argv: string[]): string | undefined {
  const index = argv.findIndex((arg) => arg === "--config");
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

async function main(): Promise<void> {
  const configArg = parseConfigArg(process.argv.slice(2));
  const configPath = resolveConfigPath(configArg);
  const config = loadConfig(configPath);

  logger.info(`loaded config from ${configPath}`);

  const store = new StateStore();
  const telegram = new TelegramApprovalBot(config.telegram.enabled, config.telegram.bot_token, config.telegram.proxy, store);
  const guardian = new Guardian(config, store, telegram);

  await guardian.start();
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
