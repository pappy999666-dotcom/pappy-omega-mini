#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const targetArgument = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith("--"));
const target = path.resolve(
  targetArgument ?? path.join(projectRoot, "src/preview/default-adapter.ts"),
);
const apply = process.argv.includes("--apply");
const backupPath = `${target}.before-sharpening-injection.bak`;

const source = fs.readFileSync(target, "utf8");
const marker = "// PAPPY_PREVIEW_SHARPENING_INJECTED";
if (source.includes(marker)) {
  console.log(JSON.stringify({ status: "already-injected", target }, null, 2));
  process.exit(0);
}

const normalNeedle = ".sharpen({ sigma: 0.7, m1: 0.5, m2: 1.2 })";
const groupNeedle = ".sharpen({ sigma: 0.55, m1: 0.4, m2: 1.1 })";
if (!source.includes(normalNeedle) || !source.includes(groupNeedle)) {
  throw new Error(
    "Expected current Pappy Sharp sharpening calls were not found; refusing to modify the file.",
  );
}

const helper = `
${marker}
const previewSharpening = {
  sigma: boundedNumber(process.env.PAPPY_PREVIEW_SHARPEN_SIGMA, 0.7, 0.1, 1.2),
  m1: boundedNumber(process.env.PAPPY_PREVIEW_SHARPEN_M1, 0.5, 0, 2),
  m2: boundedNumber(process.env.PAPPY_PREVIEW_SHARPEN_M2, 1.2, 0, 2),
};
const groupPreviewSharpening = {
  sigma: boundedNumber(process.env.PAPPY_GROUP_PREVIEW_SHARPEN_SIGMA, 0.55, 0.1, 1.2),
  m1: boundedNumber(process.env.PAPPY_GROUP_PREVIEW_SHARPEN_M1, 0.4, 0, 2),
  m2: boundedNumber(process.env.PAPPY_GROUP_PREVIEW_SHARPEN_M2, 1.1, 0, 2),
};

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}
`;

const importNeedle = 'import sharp from "sharp";';
if (!source.includes(importNeedle)) {
  throw new Error(
    "Expected the default Sharp import was not found; refusing to modify the file.",
  );
}

const next = source
  .replace(importNeedle, `${importNeedle}${helper}`)
  .replace(normalNeedle, ".sharpen(previewSharpening)")
  .replace(groupNeedle, ".sharpen(groupPreviewSharpening)");

const report = {
  status: apply ? "applied" : "dry-run",
  target,
  backup: apply ? backupPath : null,
  defaultNormalSigma: 0.7,
  defaultGroupSigma: 0.55,
  environmentOverrides: [
    "PAPPY_PREVIEW_SHARPEN_SIGMA",
    "PAPPY_PREVIEW_SHARPEN_M1",
    "PAPPY_PREVIEW_SHARPEN_M2",
    "PAPPY_GROUP_PREVIEW_SHARPEN_SIGMA",
    "PAPPY_GROUP_PREVIEW_SHARPEN_M1",
    "PAPPY_GROUP_PREVIEW_SHARPEN_M2",
  ],
  preservesNoUpscale: true,
  preservesNoCrop: true,
};

if (apply) {
  fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, next, "utf8");
  fs.renameSync(temporary, target);
}

console.log(JSON.stringify(report, null, 2));
