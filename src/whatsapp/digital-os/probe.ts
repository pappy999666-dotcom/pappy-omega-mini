/**
 * P0 live probe for Digital OS (`.osprobe`, owner-only).
 *
 * Measures two WhatsApp client facts we cannot know server-side:
 *   1. Native-flow quick_reply button cap — sends grids of 3/4/5/6/8/10 buttons
 *      and asks the owner to report which grids rendered fully and tapped.
 *   2. Own-bubble delete reliability — sends D1, then D2, then deletes D1
 *      (the "replace previous screen" policy), and asks whether D1 vanished.
 *
 * The owner reports with `.osprobe report <n1 n2 ...> [del]`; results are
 * appended to a JSONL file next to workspace-settings.json and echoed to the
 * journal for the operator.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../../config/env.js";
import type { CommandContext } from "../command-registry.js";

const GRID_SIZES = [3, 4, 5, 6, 8, 10];
const SLEEP_MS = 1_200;

const probeLogPath = join(env.SESSION_ROOT, "..", "digital-os-probe.jsonl");

function logLine(record: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  try {
    mkdirSync(dirname(probeLogPath), { recursive: true });
    appendFileSync(probeLogPath, `${line}\n`, "utf8");
  } catch {
    // Logging must never break the probe command itself.
  }
  // Mirror to the journal so operators can read results without the file.
  console.info(`[digital-os-probe] ${line}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function usageText(): string {
  return [
    "📡 DOS PROBE",
    "Usage:",
    ".osprobe              run the full probe in this chat",
    ".osprobe report 4 6 del   record your observations (grids 4,6 rendered + taps ok; del = D1 bubble disappeared)",
  ].join("\n");
}

async function loadSocket(workspaceId: string, sessionId: string): Promise<{ sendMessage: (target: string, content: Record<string, unknown>) => Promise<{ key?: Record<string, unknown> }> }> {
  const { getWhatsAppSocket } = await import("../session-manager.js");
  return getWhatsAppSocket(workspaceId, sessionId) as unknown as {
    sendMessage: (target: string, content: Record<string, unknown>) => Promise<{ key?: Record<string, unknown> }>;
  };
}

/** Send the native-flow grids + the delete probe; returns a chat summary. */
export async function runDigitalOsProbe(ctx: CommandContext): Promise<string> {
  if (!ctx.chatJid) return "This probe must run inside a WhatsApp chat (DM or group).";
  const { workspaceId, sessionId, chatJid } = ctx;
  let socket;
  try {
    socket = await loadSocket(workspaceId, sessionId);
  } catch (error) {
    return `Probe aborted: ${error instanceof Error ? error.message : String(error)}`;
  }

  logLine({ workspaceId, sessionId, chatJid, event: "start" });

  // 1) Button-cap grids.
  const sentKeys: string[] = [];
  for (const size of GRID_SIZES) {
    try {
      const buttons = Array.from({ length: size }, (_, index) => ({
        text: `B${index + 1}`,
        id: `dosprobe:${size}:${index + 1}`,
      }));
      const sent = await socket.sendMessage(chatJid, {
        text: `📡 DOS-PROBE grid n=${size} — do all ${size} buttons render? Tap one.`,
        nativeFlow: buttons,
      });
      const keyId = (sent?.key as { id?: string } | undefined)?.id ?? "?";
      sentKeys.push(`${size}:${keyId}`);
      logLine({ event: "grid-sent", size, messageId: keyId });
    } catch (error) {
      logLine({
        event: "grid-error",
        size,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(SLEEP_MS);
  }

  // 2) Bubble replacement / delete probe.
  let deleteOutcome: "ok" | "failed" | "no-key" = "no-key";
  let d1Id = "?";
  let d2Id = "?";
  try {
    const d1 = await socket.sendMessage(chatJid, { text: "📡 DOS-PROBE D1 — replacement target" });
    d1Id = (d1?.key as { id?: string } | undefined)?.id ?? "?";
    await sleep(900);
    const d2 = await socket.sendMessage(chatJid, { text: "📡 DOS-PROBE D2 — replacement bubble" });
    d2Id = (d2?.key as { id?: string } | undefined)?.id ?? "?";
    await sleep(900);
    if (d1?.key) {
      const { deleteWhatsAppMessage } = await import("../transport-adapter.js");
      await deleteWhatsAppMessage(workspaceId, sessionId, chatJid, d1.key);
      deleteOutcome = "ok";
    }
  } catch (error) {
    deleteOutcome = "failed";
    logLine({
      event: "delete-probe-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logLine({ event: "delete-probe", d1Id, d2Id, outcome: deleteOutcome });

  return [
    "📡 DOS-PROBE complete — reply with what you see on your phone:",
    "",
    "Grids sent: " + GRID_SIZES.join(" "),
    "👉 Reply: .osprobe report <sizes that rendered FULLY with all buttons and taps replied>",
    "Delete test: D1 was deleted after D2 appeared.",
    "👉 Append 'del' if D1 truly disappeared: .osprobe report 4 6 del",
    "",
    `Delete probe outcome on server: ${deleteOutcome}`,
  ].join("\n");
}

/** Record the owner's visual observations from `.osprobe report ...`. */
export function recordDigitalOsProbeReport(
  ctx: CommandContext,
  tokens: string[],
): string {
  const gridsOk = tokens.filter((token) => /^\d+$/u.test(token)).map(Number);
  const deleteOk = tokens.some((token) => /^del$/iu.test(token));
  const record = {
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    chatJid: ctx.chatJid ?? "",
    event: "report",
    gridsOk,
    deleteOk,
    raw: tokens.join(" "),
  };
  logLine(record);
  return [
    "✅ DOS-PROBE report recorded.",
    ...(gridsOk.length
      ? [`Grids fully rendered + tappable: ${gridsOk.join(", ")}`]
      : ["No grid confirmed."]),
    `D1 replacement bubble disappeared: ${deleteOk ? "YES" : "not confirmed"}`,
  ].join("\n");
}

export function digitalOsProbeUsage(): string {
  return usageText();
}
