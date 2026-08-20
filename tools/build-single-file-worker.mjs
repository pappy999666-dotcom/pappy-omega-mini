import { readFile, writeFile } from "node:fs/promises";
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
const packagePath = path.join(root, "package.json");
const runtimePath = path.join(root, ".pappy-workload-runtime.mjs");
const manifest = {
  name: "pappy-omega-mini-workload-worker",
  version: "1.1.0",
  private: true,
  main: "index.js",
  engines: { node: ">=20" },
  dependencies: { "@crysnovax/baileys": "2.7.10", pino: "9.9.0" }
};
let existing = {};
try { existing = JSON.parse(fs.readFileSync(packagePath, "utf8")); } catch {}
const merged = { ...existing, ...manifest, dependencies: { ...(existing.dependencies || {}), ...manifest.dependencies } };
delete merged.type;
fs.writeFileSync(packagePath, JSON.stringify(merged, null, 2) + "\\n", { mode: 0o600 });
function dependencyExists() {
  try {
    fs.accessSync(path.join(root, "node_modules", "@crysnovax", "baileys", "package.json"));
    fs.accessSync(path.join(root, "node_modules", "pino", "package.json"));
    return true;
  } catch { return false; }
}
if (!dependencyExists()) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const install = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status || 1);
}
fs.writeFileSync(runtimePath, runtimeSource, { mode: 0o600 });
const child = spawnSync(process.execPath, [runtimePath, "--worker-runtime", ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: "inherit" });
try { fs.unlinkSync(runtimePath); } catch {}
process.exit(child.status || 0);
`;
await writeFile(workerPath, bootstrap, { mode: 0o700 });
console.log(`built ${workerPath} (${Buffer.byteLength(bootstrap)} bytes)`);
