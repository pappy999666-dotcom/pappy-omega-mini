#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const sourceUrl =
  process.argv[2] ??
  "https://pps.whatsapp.net/v/t61.24694-24/641789215_927689696329590_2696567526240214164_n.jpg?ccb=11-4&oh=01_Q5Aa5QFq3Tlp0AZm56EJbg7Ks8to4eaV6EHuH3nPmT37T3K5OA&oe=6A92A13F&_nc_sid=5e03e0&_nc_cat=107";
const outputDir = path.resolve(
  process.argv[3] ?? path.join(process.cwd(), "artifacts/sharpening-benchmark"),
);

const variants = [
  { name: "group-current", sigma: 0.55, m1: 0.4, m2: 1.1 },
  { name: "group-injected-default", sigma: 0.55, m1: 0.4, m2: 1.1 },
  { name: "group-stronger-profile", sigma: 0.7, m1: 0.45, m2: 1.15 },
  { name: "group-aggressive-profile", sigma: 0.95, m1: 0.7, m2: 1.5 },
];

function variance(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

async function edgeMetrics(buffer) {
  const { data, info } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gradients = [];
  const laplacian = [];
  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const index = y * info.width + x;
      const left = data[index - 1];
      const right = data[index + 1];
      const up = data[index - info.width];
      const down = data[index + info.width];
      const center = data[index];
      gradients.push(Math.abs(right - left) + Math.abs(down - up));
      laplacian.push(left + right + up + down - 4 * center);
    }
  }
  return {
    gradientMean: Number(
      (gradients.reduce((sum, value) => sum + value, 0) / gradients.length).toFixed(4),
    ),
    laplacianVariance: Number(variance(laplacian).toFixed(4)),
    dimensions: `${info.width}x${info.height}`,
  };
}

const response = await fetch(sourceUrl, { redirect: "follow" });
if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
const source = Buffer.from(await response.arrayBuffer());
const sourceMetadata = await sharp(source).metadata();
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "source.jpg"), source);
const results = [];
for (const variant of variants) {
  const output = await sharp(source, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: 1920,
      height: 1920,
      fit: "inside",
      withoutEnlargement: true,
      kernel: "lanczos3",
    })
    .sharpen({ sigma: variant.sigma, m1: variant.m1, m2: variant.m2 })
    .jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const name = `${variant.name}.jpg`;
  await fs.writeFile(path.join(outputDir, name), output);
  results.push({
    ...variant,
    bytes: output.length,
    metadata: await sharp(output).metadata(),
    edges: await edgeMetrics(output),
  });
}
console.log(
  JSON.stringify(
    {
      source: {
        url: sourceUrl,
        bytes: source.length,
        width: sourceMetadata.width,
        height: sourceMetadata.height,
        format: sourceMetadata.format,
      },
      outputDir,
      results,
      interpretation: {
        note: "Higher edge metrics indicate stronger high-frequency enhancement, not recovered source detail. Visual inspection is required to reject halos or ringing.",
        noUpscale: true,
        noCrop: true,
      },
    },
    null,
    2,
  ),
);
