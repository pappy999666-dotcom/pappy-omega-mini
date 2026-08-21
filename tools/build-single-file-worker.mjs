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
const { spawnSync } = require("node:child_process");
const runtimeSource = Buffer.from(${JSON.stringify(encodedRuntime)}, "base64").toString("utf8");
const root = process.cwd();
const ansi = { reset: "\\x1b[0m", cyan: "\\x1b[36m", green: "\\x1b[92m", yellow: "\\x1b[93m", red: "\\x1b[91m", dim: "\\x1b[90m" };
const color = process.env.NO_COLOR ? false : Boolean(process.stdout.isTTY || process.env.PAPPY_COLOR === "1");
const paint = (text, tone) => color ? tone + text + ansi.reset : text;
const log = (text, tone = ansi.cyan) => process.stdout.write(paint(text, tone) + "\\n");
const packagePath = path.join(root, "package.json");
const runtimePath = path.join(root, ".pappy-workload-runtime.mjs");
const manifest = {
  name: "pappy-omega-mini-workload-worker",
  version: "1.2.1",
  private: true,
  main: "index.js",
  engines: { node: ">=20" },
  dependencies: { "@crysnovax/baileys": "2.7.12", pino: "9.9.0" }
};
let existing = {};
try { existing = JSON.parse(fs.readFileSync(packagePath, "utf8")); } catch {}
const merged = { ...existing, ...manifest, dependencies: { ...(existing.dependencies || {}), ...manifest.dependencies } };
delete merged.type;
fs.writeFileSync(packagePath, JSON.stringify(merged, null, 2) + "\\n", { mode: 0o600 });
function dependencyExists() {
  try {
    const baileys = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "@crysnovax", "baileys", "package.json"), "utf8"));
    const pino = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "pino", "package.json"), "utf8"));
    return baileys.version === manifest.dependencies["@crysnovax/baileys"] && pino.version === manifest.dependencies.pino;
  } catch { return false; }
}
log("\\n[PAPPY PANEL] Preparing this workload panel…", ansi.cyan);
if (!dependencyExists()) {
  log("[1/2] Installing the required WhatsApp runtime. Please wait until this step finishes.", ansi.yellow);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-progress", "--loglevel=error"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) {
    log("[FAILED] Node dependency installation did not finish. Re-run the same command after the panel is online.", ansi.red);
    process.exit(install.status || 1);
  }
  log("[OK] Dependencies installed successfully.", ansi.green);
} else {
  log("[OK] Node dependencies already installed.", ansi.green);
}
log("[2/2] Starting the interactive panel setup question now…", ansi.cyan);
fs.writeFileSync(runtimePath, runtimeSource, { mode: 0o600 });
const child = spawnSync(process.execPath, [runtimePath, "--worker-runtime", ...process.argv.slice(2)], { cwd: root, env: { ...process.env, PAPPY_WORKER_ENTRYPOINT: path.join(root, "index.js") }, stdio: "inherit" });
try { fs.unlinkSync(runtimePath); } catch {}
if (child.status === 75) {
  const restarted = spawnSync(process.execPath, [path.join(root, "index.js"), ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: "inherit" });
  process.exit(restarted.status || 0);
}
process.exit(child.status || 0);
`;
const sourceForMinify = bootstrap.replace(/^#![^\n]*\n/, "");
const minified = process.env.PAPPY_WORKER_MINIFY === "0"
  ? bootstrap
  : `#!/usr/bin/env node\n${(await minify(sourceForMinify, { compress: true, mangle: true, format: { comments: false } })).code}\n`;
await writeFile(workerPath, minified, { mode: 0o700 });
console.log(`built ${workerPath} (${Buffer.byteLength(minified)} bytes; minified=${process.env.PAPPY_WORKER_MINIFY !== "0"})`);
