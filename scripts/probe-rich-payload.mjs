#!/usr/bin/env node
/**
 * Phase 1 — plogme rich-payload reverse-engineering probe.
 *
 * Compiles the EXACT same wire payloads the engine produces for:
 *   1. `sock.sendSlotMachine(jid, { title, startingCredits })`   → HTML bubble
 *      (sendSlotMachine → sendHtmlMessage → prepareHtmlMessage → generateWAMessageFromContent)
 *   2. (--buttons) a native-flow button message (the shape used by the app's
 *      existing `nativeFlow: [{ text, id }]` replies — the payload that later
 *      delivers `interactiveResponseMessage.nativeFlowResponseMessage` clicks).
 *
 * It does NOT connect a socket and does NOT touch the live bot. It calls the
 * engine's own public builders with a stub identity, so the compiled structure
 * is byte-for-byte the same message object `relayMessage()` would send.
 *
 * Usage:
 *   node scripts/probe-rich-payload.mjs
 *   node scripts/probe-rich-payload.mjs --title "APPROVE" --startingCredits 100
 *   node scripts/probe-rich-payload.mjs --buttons          # also compile a native-flow buttons payload
 *   node scripts/probe-rich-payload.mjs --out /tmp/probe   # write full JSON dumps
 *
 * Output: structural blueprint on stdout + optional full payload JSON files.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateWAMessageFromContent,
  proto,
  prepareHtmlMessage,
} from "plogme";
import { generateSlotMachineHtml } from "plogme/lib/Utils/games/slot-machine.js";

// ---------------------------------------------------------------------------
// CLI args (tiny, dependency-free)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const TARGET_JID = argVal("--jid", "120363000000000000@g.us");
const TITLE = argVal("--title", "FRUIT BONANZA");
const CREDITS = Number(argVal("--startingCredits", "500"));
const DO_BUTTONS = args.includes("--buttons");
const OUT_DIR = argVal("--out", join(tmpdir(), "plogme-rich-probe"));
const FAKE_ME = "15550000000@s.whatsapp.net";

const noopLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return noopLogger; },
  level: "silent",
};

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------
const bufferLike = (v) =>
  (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) ||
  v instanceof Uint8Array;

const toBuffer = (v) =>
  typeof Buffer !== "undefined" && Buffer.isBuffer(v)
    ? v
    : Buffer.from(v);

const replacer = (_key, value) => {
  if (!bufferLike(value)) return value;
  const buf = toBuffer(value);
  const utf8 = buf.toString("utf8");
  if (utf8.trimStart().startsWith("{") || utf8.trimStart().startsWith("[")) {
    try {
      return { __json__: JSON.parse(utf8) };
    } catch {
      /* fall through to raw utf8 */
    }
  }
  if (utf8.trim().length === 0) return { __bytes__: buf.length };
  // Certificate / signature blobs are not meaningful utf8 — show hex head.
  const printable = /^[\x20-\x7e\n\r\t]*$/.test(utf8.slice(0, 4096));
  if (printable && utf8.length < 50_000) return { __utf8__: utf8 };
  return { __bytes__: buf.length, hexHead: buf.subarray(0, 48).toString("hex") };
};

// ---------------------------------------------------------------------------
// Payload compilers (mirror of the engine's own call chain)
// ---------------------------------------------------------------------------

/** Same as socket.sendSlotMachine → sendHtmlMessage, minus relay. */
async function compileSlotPayload() {
  const html = generateSlotMachineHtml({
    title: TITLE,
    startingCredits: CREDITS,
  });
  const wrapped = prepareHtmlMessage({ html });
  const fullMsg = await generateWAMessageFromContent(TARGET_JID, wrapped, {
    logger: noopLogger,
    userJid: FAKE_ME,
    messageId: "PROBE-SLOT-000000000000",
  });
  return fullMsg;
}

/**
 * Native-flow buttons payload (single Confirm-style button with an id).
 * Mirrors the normalized shape plogme's interactive handler produces from
 * content `{ interactiveMessage: { body, header, nativeFlowMessage } }`
 * (see lib/Socket/interactive-handler.js) — plain objects, no proto classes.
 */
async function compileNativeFlowPayload(button) {
  const content = {
    interactiveMessage: {
      body: { text: "Screen A — confirm this action" },
      footer: { text: "" },
      header: {
        title: "",
        subtitle: "",
        hasMediaAttachment: false,
      },
      nativeFlowMessage: {
        buttons: [
          {
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
              display_text: button.text,
              id: button.id,
            }),
          },
        ],
      },
    },
  };
  const fullMsg = await generateWAMessageFromContent(TARGET_JID, content, {
    logger: noopLogger,
    userJid: FAKE_ME,
    messageId: "PROBE-BTN-000000000000",
  });
  return fullMsg;
}

// ---------------------------------------------------------------------------
// Decode base64 "data" blobs that protobufjs toJSON emits (unifiedResponse.data)
// ---------------------------------------------------------------------------
function decodeWireData(node) {
  if (Array.isArray(node)) {
    for (const item of node) decodeWireData(item);
    return;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (key === "data" && typeof value === "string" && value.length > 40) {
        try {
          const decoded = Buffer.from(value, "base64").toString("utf8");
          const parsed = JSON.parse(decoded);
          node[key] = { __json__: parsed };
        } catch {
          /* not a JSON blob — leave as-is */
        }
      } else if (value && typeof value === "object") {
        decodeWireData(value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Blueprint printer
// ---------------------------------------------------------------------------
const TRUNC = { str: 220, arr: 6 };
function walk(value, out, depth, path) {
  if (depth > 14) { out.push(`${"  ".repeat(depth)}… (depth cap)`); return; }
  const pad = "  ".repeat(depth);
  if (value === null || value === undefined) {
    out.push(`${pad}${path}: ${String(value)}`); return;
  }
  if (Array.isArray(value)) {
    out.push(`${pad}${path}: Array(${value.length})`);
    for (let i = 0; i < Math.min(value.length, TRUNC.arr); i++) {
      const el = value[i];
      if (el && typeof el === "object") {
        out.push(`${pad}  [${i}]`);
        walk(el, out, depth + 2, "(object)");
      } else {
        out.push(`${pad}  [${i}] = ${summarize(el)}`);
      }
    }
    if (value.length > TRUNC.arr)
      out.push(`${pad}  … ${value.length - TRUNC.arr} more`);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    out.push(`${pad}${path}: object {${keys.length} keys}`);
    for (const key of keys) {
      const el = value[key];
      if (el && typeof el === "object") {
        walk(el, out, depth + 1, key);
      } else {
        out.push(`${pad}  ${key} = ${summarize(el)}`);
      }
    }
    return;
  }
  out.push(`${pad}${path} = ${summarize(value)}`);
}
function summarize(value) {
  switch (typeof value) {
    case "string": {
      const s = value.replace(/\s+/g, " ");
      return `"${s.length > TRUNC.str ? s.slice(0, TRUNC.str) + `… (${value.length} chars)` : s}"`;
    }
    case "number": return String(value);
    case "boolean": return String(value);
    default: return String(value);
  }
}

// ---------------------------------------------------------------------------
// HTML introspection (is there ANY back-channel to the bot?)
// ---------------------------------------------------------------------------
function analyzeHtml(html) {
  const networkMarkers = {
    "fetch(": /fetch\s*\(/.test(html),
    XMLHttpRequest: html.includes("XMLHttpRequest"),
    WebSocket: /new\s+WebSocket/.test(html),
    "navigator.sendBeacon": html.includes("sendBeacon"),
    postMessage: html.includes("postMessage"),
    "https?:// (any URL)": /\bhttps?:\/\//.test(html),
  };
  const networkHits = Object.entries(networkMarkers)
    .filter(([, hit]) => hit)
    .map(([name]) => name);
  const hasScript = html.includes("<script");
  const verdict =
    networkHits.length === 0
      ? hasScript
        ? "CLIENT-SIDE JS ONLY — the bubble runs <script> but contains NO network API. Screen transitions morph locally; clicks cannot reach the bot backend."
        : "STATIC HTML — no script, no network."
      : `Contains potential back-channel markers: ${networkHits.join(", ")} — needs a live-client probe to confirm reachability.`;
  return {
    htmlLength: html.length,
    hasScript,
    checks: { ...networkMarkers, "<script": hasScript },
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const slotMsg = await compileSlotPayload();
const slot = JSON.parse(JSON.stringify(slotMsg, replacer));
decodeWireData(slot);

// Pull out the decoded rich-response + HTML for the analysis section.
let unifiedData = null;
let html = null;
try {
  const inner = slot?.message?.botForwardedMessage?.message?.richResponseMessage;
  unifiedData = inner?.unifiedResponse?.data?.__json__ ?? null;
  html =
    unifiedData?.sections?.[0]?.view_model?.primitive?.payload ??
    unifiedData?.sections?.[0]?.view_model?.primitive?.html ??
    null;
} catch {
  /* tolerate shape drift */
}

const lines = [];
lines.push("=".repeat(72));
lines.push("PLOGME RICH-PAYLOAD PROBE (Phase 1)");
lines.push(`targetJid=${TARGET_JID}  me=${FAKE_ME}  plogme=1.0.3`);
lines.push("=".repeat(72));
lines.push("");
lines.push("── 1) sendSlotMachine equivalent payload ──────────────────────────");
lines.push(`slot HTML: title=${TITLE} credits=${CREDITS}, ` +
  `htmlLen=${html ? html.length : "?"}`);
if (html) {
  const analysis = analyzeHtml(html);
  lines.push(`  channel verdict: ${analysis.verdict}`);
  lines.push(`  marker checks: ${JSON.stringify(analysis.checks)}`);
}
lines.push("");
lines.push("Top-level message envelope:");
for (const key of Object.keys(slot)) {
  const val = slot[key];
  lines.push(`  ${key}: ${typeof val === "object" ? (Array.isArray(val) ? `Array(${val.length})` : "object") : summarize(val)}`);
}
lines.push("");
lines.push("Full structural blueprint of slot payload:");
walk(slot, lines, 0, "message");
lines.push("");

if (DO_BUTTONS) {
  lines.push("── 2) native-flow buttons payload (Confirm/Cancel substrate) ──────");
  const btnMsg = await compileNativeFlowPayload({ text: "Confirm", id: "digital:confirm:abc123" });
  const btn = JSON.parse(JSON.stringify(btnMsg, replacer));
  walk(btn, lines, 0, "message");
  lines.push("");
  lines.push("How a click returns to the bot (engine + app wiring):");
  lines.push("  user taps button → WhatsApp sends interactiveResponseMessage.nativeFlowResponseMessage");
  lines.push("  → app extractWhatsAppInteraction() parses paramsJson { id, display_text }");
  lines.push("  → command handler executes action and sends a follow-up (new bubble).");
  lines.push("");
}

lines.push("─ raw dumps ───────────────────────────────────────────────────────");
await mkdir(OUT_DIR, { recursive: true });
const slotFile = join(OUT_DIR, "slot-payload.json");
const htmlFile = join(OUT_DIR, "slot-payload.html");
await writeFile(slotFile, JSON.stringify(slot, null, 2));
if (html) await writeFile(htmlFile, html);
lines.push(`  wrote ${slotFile}`);
if (html) lines.push(`  wrote ${htmlFile}`);
if (DO_BUTTONS) {
  const btnMsg2 = await compileNativeFlowPayload({ text: "Confirm", id: "digital:confirm:abc123" });
  const btnFile = join(OUT_DIR, "native-flow-buttons.json");
  await writeFile(btnFile, JSON.stringify(JSON.parse(JSON.stringify(btnMsg2, replacer)), null, 2));
  lines.push(`  wrote ${btnFile}`);
}
lines.push("");

process.stdout.write(lines.join("\n") + "\n");
