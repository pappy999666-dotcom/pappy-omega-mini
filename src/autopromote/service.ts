import { createHash, randomUUID } from "node:crypto";
import {
  claimAutoPromoteOccurrence,
  deleteAutoPromoteConfig as deleteAutoPromoteConfigPersistence,
  disableAutoPromoteConfig,
  getAutoPromoteConfig,
  getAutoPromoteRun,
  listAutoPromoteConfigs,
  listAutoPromoteRuns,
  listRecoverableAutoPromoteRuns,
  saveAutoPromoteConfig,
  saveAutoPromoteRun,
  setAutoPromoteConfigState,
} from "../persistence/mongo.js";
import { getWorkspaceOwnerTelegramUserId, listAllSessions } from "../core/session-registry.js";
import type { JobOrchestrator } from "../jobs/job-orchestrator.js";
import {
  DEFAULT_AUTOPROMOTE_SLOT_TIMES,
  DEFAULT_AUTOPROMOTE_TIMEZONE,
  occurrenceId,
  slotsForTimesPerDay,
  validateAutoPromoteInput,
  type AutoPromoteConfig,
  type AutoPromoteRun,
  type AutoPromoteScope,
} from "./types.js";
import { zonedTimeToUtc } from "./types.js";

const AUTOPROMOTE_TICK_MS = 15_000;
const DEFAULT_COOLDOWN_MINUTES = 30;
const DEFAULT_MISFIRE_GRACE_MINUTES = 30;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function priority(scope: AutoPromoteScope): number {
  return scope === "SESSION" ? 0 : scope === "USER" ? 1 : 2;
}

function resolveTargetSessionIds(config: AutoPromoteConfig): string[] {
  const sessions = listAllSessions().filter(
    (session) => session.status === "ACTIVE" && session.authHealth !== "INVALID",
  );
  if (config.scope === "SESSION")
    return config.sessionId ? [config.sessionId] : [];
  if (config.scope === "USER")
    return sessions
      .filter((session) => getWorkspaceOwnerTelegramUserId(session.workspaceId) === config.ownerTelegramUserId)
      .map((session) => session.sessionId);
  // Global owner configurations follow the live session registry. Newly paired
  // eligible sessions join on the next occurrence without recreating the config.
  return sessions.map((session) => session.sessionId);
}

function newRun(
  config: AutoPromoteConfig,
  sessionId: string,
  occurrence: { id: string; scheduledAt: number },
): AutoPromoteRun {
  const now = Date.now();
  const repetitions = config.command === "allstatusx" ? config.allstatusxPostsPerGroup ?? 1 : 1;
  return {
    id: randomUUID(),
    configId: config.id,
    occurrenceId: occurrence.id,
    scope: config.scope,
    ownerTelegramUserId: config.ownerTelegramUserId,
    sessionId,
    scheduledAt: occurrence.scheduledAt,
    status: "SCHEDULED",
    totalGroups: 0,
    completedGroups: 0,
    failedGroups: 0,
    currentRepetition: 0,
    totalRepetitions: repetitions,
    retryCount: 0,
    successCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createAutoPromoteConfig(input: {
  scope: AutoPromoteScope;
  ownerTelegramUserId: string;
  ownerWorkspaceId?: string;
  sessionId?: string;
  targetSessionIds?: string[];
  command: AutoPromoteConfig["command"];
  payload: AutoPromoteConfig["payload"];
  days: number;
  timesPerDay: number;
  allstatusxPostsPerGroup?: number;
  timezone?: string;
  startDate?: string;
  slotTimes?: AutoPromoteConfig["slotTimes"];
  cooldownMinutes?: number;
  misfireGraceMinutes?: number;
}): Promise<AutoPromoteConfig> {
  validateAutoPromoteInput({
    days: input.days,
    timesPerDay: input.timesPerDay,
    ...(input.allstatusxPostsPerGroup !== undefined ? { allstatusxPostsPerGroup: input.allstatusxPostsPerGroup } : {}),
  });
  if (input.command === "allstatusx" && input.allstatusxPostsPerGroup === undefined)
    throw new Error("All Status X requires posts per group.");
  const startDate = input.startDate ?? new Date().toISOString().slice(0, 10);
  const config: AutoPromoteConfig = {
    id: randomUUID(),
    scope: input.scope,
    ownerTelegramUserId: input.ownerTelegramUserId,
    ...(input.ownerWorkspaceId ? { ownerWorkspaceId: input.ownerWorkspaceId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.targetSessionIds ? { targetSessionIds: input.targetSessionIds } : {}),
    command: input.command,
    payload: input.payload,
    days: input.days,
    timesPerDay: input.timesPerDay,
    ...(input.allstatusxPostsPerGroup !== undefined
      ? { allstatusxPostsPerGroup: input.allstatusxPostsPerGroup }
      : {}),
    timezone: input.timezone ?? DEFAULT_AUTOPROMOTE_TIMEZONE,
    slotTimes: input.slotTimes ?? DEFAULT_AUTOPROMOTE_SLOT_TIMES,
    startDate,
    endDate: addDays(startDate, input.days - 1),
    enabled: true,
    state: "SCHEDULED",
    cooldownMinutes: input.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
    misfireGraceMinutes: input.misfireGraceMinutes ?? DEFAULT_MISFIRE_GRACE_MINUTES,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveAutoPromoteConfig(config);
  return config;
}

export async function cancelAutoPromoteConfig(configId: string): Promise<void> {
  await disableAutoPromoteConfig(configId);
}

export async function deleteAutoPromoteConfig(
  configId: string,
  runtime?: Pick<JobOrchestrator, "cancel">,
): Promise<void> {
  const runs = await listAutoPromoteRuns({ configId, limit: 5_000 }).catch(() => []);
  for (const run of runs) {
    if (run.jobId) await runtime?.cancel(run.jobId).catch(() => undefined);
  }
  await deleteAutoPromoteConfigPersistence(configId);
}

export async function pauseAutoPromoteConfig(configId: string): Promise<void> {
  await setAutoPromoteConfigState(configId, "PAUSED", false);
}

export async function resumeAutoPromoteConfig(configId: string): Promise<void> {
  await setAutoPromoteConfigState(configId, "SCHEDULED", true);
}

export async function ensureAutoPromoteOccurrences(
  now = Date.now(),
): Promise<number> {
  const configs = await listAutoPromoteConfigs({ enabled: true, limit: 500 });
  let created = 0;
  for (const config of configs) {
    const sessions = resolveTargetSessionIds(config);
    if (!sessions.length) continue;
    const existingRuns = await listAutoPromoteRuns({ configId: config.id, limit: 5000 }).catch(() => []);
    const existingOccurrences = new Set(existingRuns.map((run) => run.occurrenceId));
    for (let day = 0; day < config.days; day += 1) {
      const date = addDays(config.startDate, day);
      const slots = slotsForTimesPerDay(config.timesPerDay);
      for (const slot of slots) {
        const scheduledAt = zonedTimeToUtc(date, config.slotTimes[slot], config.timezone);
        for (const sessionId of sessions) {
          const id = occurrenceId(config.id, date, slot, sessionId);
          if (existingOccurrences.has(id)) continue;
          const result = await claimAutoPromoteOccurrence(
            id,
            newRun(config, sessionId, { id, scheduledAt }),
          );
          existingOccurrences.add(id);
          if (result?.createdAt && result.createdAt === result.updatedAt) created += 1;
        }
      }
    }
    if (now > zonedTimeToUtc(config.endDate, config.slotTimes.lateNight, config.timezone)) {
      await disableAutoPromoteConfig(config.id);
    }
  }
  return created;
}

export async function dispatchAutoPromoteDueRuns(
  orchestrator: JobOrchestrator,
  now = Date.now(),
): Promise<number> {
  const candidates = (await listRecoverableAutoPromoteRuns(now)).filter(
    (run) => run.status === "SCHEDULED" || run.status === "WAITING_FOR_SESSION",
  );
  const grouped = new Map<string, AutoPromoteRun[]>();
  for (const run of candidates) {
    const list = grouped.get(run.sessionId) ?? [];
    list.push(run);
    grouped.set(run.sessionId, list);
  }
  let dispatched = 0;
  for (const [sessionId, runs] of grouped) {
    const ordered = runs.sort((a, b) => {
      const scopeOrder = priority(a.scope) - priority(b.scope);
      return scopeOrder || a.scheduledAt - b.scheduledAt || a.createdAt - b.createdAt;
    });
    const current = (await listAutoPromoteRuns({ sessionId, limit: 50 }).catch(() => [])).find(
      (run) =>
        run.status === "QUEUED" ||
        run.status === "RUNNING" ||
        (run.status === "COOLDOWN" && (run.cooldownUntil ?? 0) > now),
    );
    if (current) continue;
    const run = ordered[0];
    if (!run) continue;
    const config = await getAutoPromoteConfig(run.configId);
    if (!config || !config.enabled || config.state === "PAUSED" || config.state === "CANCELLED") {
      await saveAutoPromoteRun({ ...run, status: "CANCELLED", updatedAt: now });
      continue;
    }
    if (now - run.scheduledAt > config.misfireGraceMinutes * 60_000) {
      await saveAutoPromoteRun({ ...run, status: "EXPIRED", finishedAt: now, updatedAt: now });
      continue;
    }
    const session = listAllSessions().find((item) => item.sessionId === sessionId);
    if (!session || session.status !== "ACTIVE") {
      await saveAutoPromoteRun({ ...run, status: "WAITING_FOR_SESSION", updatedAt: now });
      continue;
    }
    const groups = await import("../whatsapp/transport-adapter.js")
      .then(({ listGroups }) => listGroups(session.workspaceId, session.sessionId))
      .catch(() => [] as Array<{ jid: string }>);
    const groupJids = groups.map((group) => group.jid).filter(Boolean);
    if (!groupJids.length) {
      await saveAutoPromoteRun({ ...run, status: "WAITING_FOR_SESSION", updatedAt: now });
      continue;
    }
    const childKind = config.command === "allchat" ? "allchat" : "allstatus";
    const payload = {
      groups: groupJids,
      text: config.payload.text ?? config.payload.caption ?? "",
      ...(config.payload.media ? { media: config.payload.media } : {}),
      ...(config.command === "allstatusx"
        ? { count: config.allstatusxPostsPerGroup ?? 1 }
        : {}),
      autoPromoteRunId: run.id,
      autoPromoteConfigId: config.id,
      autoPromoteScope: config.scope,
    };
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const child = await orchestrator.enqueue({
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      kind: childKind,
      payload,
      idempotencyKey: `autopromote:${run.occurrenceId}:${payloadHash}`,
    });
    await saveAutoPromoteRun({
      ...run,
      status: "QUEUED",
      jobId: child.jobId,
      totalGroups: groupJids.length,
      totalRepetitions: config.command === "allstatusx" ? config.allstatusxPostsPerGroup ?? 1 : 1,
      updatedAt: now,
    });
    dispatched += 1;
  }
  return dispatched;
}

export class AutoPromoteScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly orchestrator: JobOrchestrator) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), AUTOPROMOTE_TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await ensureAutoPromoteOccurrences(now);
      await dispatchAutoPromoteDueRuns(this.orchestrator, now);
    } finally {
      this.running = false;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}


export async function recordAutoPromoteChildCompletion(job: {
  payload: Record<string, unknown>;
  state: string;
  progress: {
    completed: number;
    total?: number;
    success: number;
    failed: number;
    retrying: number;
    currentGroup?: string;
    currentAction?: string;
    lastResult?: string;
  };
  error?: string;
}): Promise<void> {
  const runId = typeof job.payload.autoPromoteRunId === "string" ? job.payload.autoPromoteRunId : undefined;
  if (!runId) return;
  const run = await getAutoPromoteRun(runId);
  if (!run) return;
  const now = Date.now();
  const config = await getAutoPromoteConfig(run.configId);
  const completed = job.progress.completed;
  const succeeded = job.progress.success;
  const failed = job.progress.failed;
  const terminal = job.state === "COMPLETED" || job.state === "PARTIAL" || job.state === "FAILED";
  const nextStatus = terminal
    ? job.state === "COMPLETED" || succeeded > 0
      ? "COOLDOWN"
      : "FAILED"
    : job.state === "CANCELLED"
      ? "CANCELLED"
      : "RUNNING";
  await saveAutoPromoteRun({
    ...run,
    status: nextStatus,
    startedAt: run.startedAt ?? now,
    ...(terminal ? { finishedAt: now } : {}),
    totalGroups: job.progress.total ?? run.totalGroups,
    completedGroups: completed,
    failedGroups: failed,
    successCount: succeeded,
    retryCount: job.progress.retrying,
    ...(job.progress.currentGroup ? { currentGroup: job.progress.currentGroup } : {}),
    ...(terminal && nextStatus === "COOLDOWN" && config
      ? { cooldownUntil: now + config.cooldownMinutes * 60_000 }
      : {}),
    ...((job.error ?? job.progress.lastResult)
      ? { error: (job.error ?? job.progress.lastResult)!.slice(0, 500) }
      : {}),
    updatedAt: now,
  });
}


export async function recordAutoPromoteProgress(input: {
  runId: string;
  currentGroup?: string;
  currentRepetition?: number;
  completedGroups?: number;
  failedGroups?: number;
  successCount?: number;
  retryCount?: number;
  totalGroups?: number;
  totalRepetitions?: number;
  error?: string;
}): Promise<void> {
  const run = await getAutoPromoteRun(input.runId);
  if (!run) return;
  await saveAutoPromoteRun({
    ...run,
    ...(run.status === "QUEUED" || run.status === "WAITING_FOR_SESSION" ? { status: "RUNNING" as const } : {}),
    ...(input.currentGroup !== undefined ? { currentGroup: input.currentGroup } : {}),
    ...(input.currentRepetition !== undefined ? { currentRepetition: input.currentRepetition } : {}),
    ...(input.completedGroups !== undefined ? { completedGroups: input.completedGroups } : {}),
    ...(input.failedGroups !== undefined ? { failedGroups: input.failedGroups } : {}),
    ...(input.successCount !== undefined ? { successCount: input.successCount } : {}),
    ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
    ...(input.totalGroups !== undefined ? { totalGroups: input.totalGroups } : {}),
    ...(input.totalRepetitions !== undefined ? { totalRepetitions: input.totalRepetitions } : {}),
    ...(input.error !== undefined ? { error: input.error.slice(0, 500) } : {}),
    updatedAt: Date.now(),
  });
}
