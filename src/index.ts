import { mkdir } from "node:fs/promises";
import { env, assertProductionSecrets } from "./config/env.js";
import { createTelegramBot } from "./telegram/bot.js";

async function main(): Promise<void> {
  assertProductionSecrets();
  await mkdir(env.SESSION_ROOT, { recursive: true });
  await mkdir(env.MEDIA_ROOT, { recursive: true });

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log(
      "[pappy-omega-mini] Scaffold ready. Set TELEGRAM_BOT_TOKEN to start the Telegram gateway.",
    );
    console.log(
      "[pappy-omega-mini] WhatsApp transport remains isolated behind the session-manager boundary.",
    );
    return;
  }

  const bot = createTelegramBot();
  await bot.launch();
  console.log("[pappy-omega-mini] Telegram gateway online.");

  const shutdown = async (signal: string) => {
    console.log(
      `[pappy-omega-mini] ${signal} received; shutting down cleanly.`,
    );
    bot.stop(signal);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[pappy-omega-mini] fatal startup error", error);
  process.exitCode = 1;
});
