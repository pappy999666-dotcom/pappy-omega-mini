import type { WorkerContext } from "./job-contracts.js";

export interface BatchItemResult {
  status: "success" | "failed" | "skipped";
  error?: string;
}

export interface BoundedBatchOptions<T> {
  items: T[];
  concurrency: number;
  context: WorkerContext;
  processItem: (item: T, signal: AbortSignal) => Promise<BatchItemResult>;
}

export async function runBoundedBatch<T>(
  options: BoundedBatchOptions<T>,
): Promise<{ success: number; failed: number; skipped: number }> {
  const concurrency = Math.max(1, Math.min(32, options.concurrency));
  let cursor = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  const startedAt = Date.now();
  const controller = new AbortController();

  const next = async (): Promise<void> => {
    while (true) {
      await options.context.waitIfPaused();
      if (options.context.isCancellationRequested()) {
        controller.abort();
        return;
      }
      const index = cursor++;
      if (index >= options.items.length) return;
      const result = await options
        .processItem(options.items[index] as T, controller.signal)
        .catch((error: unknown) => ({
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }));
      if (result.status === "success") success += 1;
      else if (result.status === "failed") failed += 1;
      else skipped += 1;
      const completed = success + failed + skipped;
      const elapsedMs = Date.now() - startedAt;
      const rate = elapsedMs > 0 ? completed / (elapsedMs / 1000) : 0;
      await options.context.report({
        completed,
        total: options.items.length,
        success,
        failed,
        skipped,
        rate,
        elapsedMs,
      });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, options.items.length || 1) },
      () => next(),
    ),
  );
  return { success, failed, skipped };
}
