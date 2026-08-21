import { readFile, writeFile } from "node:fs/promises";
import { minify } from "terser";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const workerPath = join(root, "worker-package", "index.js");
const runtimeSource = await readFile(join(root, "tools", "worker-runtime-source.mjs"), "utf8");
const encodedRuntime = Buffer.from(runtimeSource, "utf8").toString("base64");
const bootstrap = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const runtimeSource = Buffer.from(${JSON.stringify(encodedRuntime)}, "base64").toString("utf8");
const root = process.cwd();
const ansi = { reset: "\\x1b[0m", cyan: "\\x1b[36m", green: "\\x1b[92m", yellow: "\\x1b[93m", red: "\\x1b[91m", dim: "\\x1b[90m" };
const color = process.env.NO_COLOR ? false : Boolean(process.stdout.isTTY || process.env.PAPPY_COLOR === "1");
const paint = (text, tone) => color ? tone + text + ansi.reset : text;
const log = (text, tone = ansi.cyan) => process.stdout.write(paint(text, tone) + "\\n");
let pulseTimer;
function startPulse(label) {
  let seconds = 0;
  log("[PROCESSING] " + label + " · started · please do not type yet", ansi.yellow);
  pulseTimer = setInterval(() => {
    seconds += 5;
    log("[PROCESSING] " + label + " · still working · " + seconds + "s elapsed · panel is not frozen", ansi.yellow);
  }, 5_000);
}
function stopPulse() {
  if (pulseTimer) clearInterval(pulseTimer);
  pulseTimer = undefined;
}
function runInstall(npm, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status: status ?? 1, signal }));
  });
}
const packagePath = path.join(root, "package.json");
const runtimePath = path.join(root, ".pappy-workload-runtime.mjs");
const manifest = {
  name: "pappy-omega-mini-workload-worker",
  version: "1.2.5",
  private: true,
  main: "index.js",
  engines: { node: ">=20" },
  dependencies: { "@crysnovax/baileys": "2.7.12", pino: "9.9.0" }
};
function dependencyExists() {
  try {
    const baileys = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "@crysnovax", "baileys", "package.json"), "utf8"));
    const pino = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "pino", "package.json"), "utf8"));
    return baileys.version === manifest.dependencies["@crysnovax/baileys"] && pino.version === manifest.dependencies.pino;
  } catch { return false; }
}
async function main() {
  log("\\n[PAPPY PANEL] Boot sequence started · Node.js " + process.version, ansi.cyan);
  log("[STAGE 1/4] Reading panel folder and preparing private worker files…", ansi.cyan);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(packagePath, "utf8")); } catch {}
  const merged = { ...existing, ...manifest, dependencies: { ...(existing.dependencies || {}), ...manifest.dependencies } };
  delete merged.type;
  fs.writeFileSync(packagePath, JSON.stringify(merged, null, 2) + "\\n", { mode: 0o600 });
  if (!dependencyExists()) {
    for (;;) {
      log("[STAGE 2/4] Required WhatsApp dependencies are not ready.", ansi.yellow);
      startPulse("Installing Baileys 2.7.12 and the Pino logger");
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      let install;
      try {
        install = await runInstall(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-progress", "--loglevel=error"]);
      } finally {
        stopPulse();
      }
      if (install.status !== 0) {
        log("[RETRY] Dependency installation returned exit code " + install.status + ". The panel stays online; retrying in 10 seconds.", ansi.yellow);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      log("[OK] Dependencies installed successfully.", ansi.green);
      break;
    }
  } else {
    log("[STAGE 2/4] Dependencies already installed · skipping npm install.", ansi.green);
  }
  log("[STAGE 3/4] Verifying the installed runtime before asking questions…", ansi.cyan);
  if (!dependencyExists()) {
    log("[FAILED] The dependency check did not pass after installation. Run the same command again.", ansi.red);
    process.exit(1);
  }
  log("[OK] Runtime verification passed.", ansi.green);
  log("[STAGE 4/4] Launching the interactive PAPPY setup now…", ansi.cyan);
  fs.writeFileSync(runtimePath, runtimeSource, { mode: 0o600 });
  const entrypoint = path.join(root, "index.js");
  const args = process.argv.slice(2);
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function pendingUpdate() {
    try { return JSON.parse(fs.readFileSync(path.join(root, "pappy-workload-data", ".pappy-update-state.json"), "utf8")); } catch { return undefined; }
  }
  function rollbackPendingUpdate() {
    const pending = pendingUpdate();
    if (!pending?.backupPath || !fs.existsSync(pending.backupPath)) return false;
    fs.copyFileSync(pending.backupPath, entrypoint);
    try { fs.unlinkSync(pending.backupPath); } catch {}
    try { fs.unlinkSync(path.join(root, "pappy-workload-data", ".pappy-update-state.json")); } catch {}
    log("[ROLLBACK] The new release did not become healthy. Previous index.js restored; sessions and auth data were preserved.", ansi.yellow);
    return true;
  }
  let crashCount = 0;
  for (;;) {
    const child = spawnSync(process.execPath, [runtimePath, "--worker-runtime", ...args], { cwd: root, env: { ...process.env, PAPPY_WORKER_ENTRYPOINT: entrypoint }, stdio: "inherit" });
    try { fs.unlinkSync(runtimePath); } catch {}
    if (child.status === 75) {
      const restarted = spawnSync(process.execPath, [entrypoint, ...args], { cwd: root, env: process.env, stdio: "inherit" });
      if (restarted.status === 0) process.exit(0);
      if (rollbackPendingUpdate()) { crashCount = 0; continue; }
      log("[RESTART] Updated worker exited before readiness; retrying in 5 seconds.", ansi.yellow);
      await sleep(5_000);
      continue;
    }
    if (child.status === 0) process.exit(0);
    if (rollbackPendingUpdate()) { crashCount = 0; continue; }
    crashCount += 1;
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(crashCount - 1, 4));
    log("[RESTART] Worker stopped unexpectedly. Panel remains online; restarting in " + Math.ceil(delay / 1000) + " seconds.", ansi.yellow);
    await sleep(delay);
  }
}
main().catch(async (error) => {
  stopPulse();
  log("[RETRY] Panel bootstrap encountered a recoverable error: " + (error instanceof Error ? error.message : String(error)), ansi.yellow);
  log("[RETRY] The panel process remains alive and will retry setup in 10 seconds.", ansi.yellow);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  process.exitCode = 75;
});
`;
const sourceForMinify = bootstrap.replace(/^#![^\n]*\n/, "");
const minified = process.env.PAPPY_WORKER_MINIFY === "0"
  ? bootstrap
  : `#!/usr/bin/env node\n${(await minify(sourceForMinify, { compress: true, mangle: true, format: { comments: false } })).code}\n`;
await writeFile(workerPath, minified, { mode: 0o700 });
console.log(`built ${workerPath} (${Buffer.byteLength(minified)} bytes; minified=${process.env.PAPPY_WORKER_MINIFY !== "0"})`);
