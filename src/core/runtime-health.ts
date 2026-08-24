import { monitorEventLoopDelay } from "node:perf_hooks";

export interface RuntimeHealthSnapshot {
  eventLoopLagMs: { p50: number; p95: number; max: number };
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  cpuPercent: number;
  sampledAt: number;
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let previousCpu = process.cpuUsage();
let previousSampleAt = Date.now();
let latest: RuntimeHealthSnapshot = {
  eventLoopLagMs: { p50: 0, p95: 0, max: 0 },
  memory: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 },
  cpuPercent: 0,
  sampledAt: Date.now(),
};

function sample(): RuntimeHealthSnapshot {
  const now = Date.now();
  const elapsedUs = Math.max(1, (now - previousSampleAt) * 1_000);
  const cpu = process.cpuUsage(previousCpu);
  previousCpu = process.cpuUsage();
  previousSampleAt = now;
  const memory = process.memoryUsage();
  const toMs = (value: number): number => Number((value / 1e6).toFixed(2));
  latest = {
    eventLoopLagMs: histogram
      ? {
          p50: toMs(histogram.percentile(50)),
          p95: toMs(histogram.percentile(95)),
          max: toMs(histogram.max),
        }
      : { p50: 0, p95: 0, max: 0 },
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    cpuPercent: Number((((cpu.user + cpu.system) / elapsedUs) * 100).toFixed(2)),
    sampledAt: now,
  };
  histogram?.reset();
  return latest;
}

export function startRuntimeHealthMonitor(): void {
  if (timer) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  previousCpu = process.cpuUsage();
  previousSampleAt = Date.now();
  timer = setInterval(sample, 5_000);
  timer.unref?.();
  sample();
}

export function getRuntimeHealthSnapshot(): RuntimeHealthSnapshot {
  return {
    ...latest,
    eventLoopLagMs: { ...latest.eventLoopLagMs },
    memory: { ...latest.memory },
  };
}

export function stopRuntimeHealthMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  histogram?.disable();
  histogram = undefined;
}
