import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkloadPackageDocument {
  source: Buffer;
  filename: string;
}

const packageRoot = join(process.cwd(), "worker-package");

export async function readWorkloadPackageDocuments(): Promise<WorkloadPackageDocument[]> {
  const names = ["index.js", "package.json", "README.md"];
  return Promise.all(names.map(async (name) => ({
    source: await readFile(join(packageRoot, name)),
    filename: `pappy-omega-mini-worker-${name}`,
  })));
}
