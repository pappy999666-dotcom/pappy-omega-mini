import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface RuntimeHealthSnapshot {
  eventLoopLagMs: { p50: number; p95: number; p99: number; max: number };
  eventLoopUtilization: { active: number; idle: number; utilization: number };
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
  activeHandles: number;
  activeRequests: number;
  cpuPercent: number;
  sampledAt: number;
}

let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let previousCpu = process.cpuUsage();
let previousSampleAt = Date.now();
let previousEventLoopUtilization = performance.eventLoopUtilization();
let latest: RuntimeHealthSnapshot = {
  eventLoopLagMs: { p50: 0, p95: 0, p99: 0, max: 0 },
  eventLoopUtilization: { active: 0, idle: 0, utilization: 0 },
  memory: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 },
  activeHandles: 0,
  activeRequests: 0,
  cpuPercent: 0,
  sampledAt: Date.now(),
};

function activeResourceCount(name: "_getActiveHandles" | "_getActiveRequests"): number {
  const processWithInternals = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  try {
    return processWithInternals[name]?.().length ?? 0;
  } catch {
    return 0;
  }
}

function sample(): RuntimeHealthSnapshot {
  const now = Date.now();
  const elapsedUs = Math.max(1, (now - previousSampleAt) * 1_000);
  const cpu = process.cpuUsage(previousCpu);
  previousCpu = process.cpuUsage();
  previousSampleAt = now;
  const memory = process.memoryUsage();
  const elu = performance.eventLoopUtilization(previousEventLoopUtilization);
  previousEventLoopUtilization = performance.eventLoopUtilization();
  const toMs = (value: number): number => Number((value / 1e6).toFixed(2));
  latest = {
    eventLoopLagMs: histogram
      ? {
          p50: toMs(histogram.percentile(50)),
          p95: toMs(histogram.percentile(95)),
          p99: toMs(histogram.percentile(99)),
          max: toMs(histogram.max),
        }
      : { p50: 0, p95: 0, p99: 0, max: 0 },
    eventLoopUtilization: {
      active: Number(elu.active.toFixed(2)),
      idle: Number(elu.idle.toFixed(2)),
      utilization: Number(elu.utilization.toFixed(4)),
    },
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    activeHandles: activeResourceCount("_getActiveHandles"),
    activeRequests: activeResourceCount("_getActiveRequests"),
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
  previousEventLoopUtilization = performance.eventLoopUtilization();
  timer = setInterval(sample, 5_000);
  timer.unref?.();
  sample();
}

export function getRuntimeHealthSnapshot(): RuntimeHealthSnapshot {
  return {
    ...latest,
    eventLoopLagMs: { ...latest.eventLoopLagMs },
    eventLoopUtilization: { ...latest.eventLoopUtilization },
    memory: { ...latest.memory },
  };
}

export function stopRuntimeHealthMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  histogram?.disable();
  histogram = undefined;
}
