import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";

export interface TraceWrite {
  traceId: string;
  workspaceId: string;
  sessionId: string;
  messageId?: string;
  direction: "inbound" | "outbound";
  remoteJid?: string;
  senderJid?: string;
  normalizedText?: string;
  authorized?: boolean;
  handler?: string;
  outcome: "received" | "ignored" | "processed" | "replied" | "failed";
  failureReason?: string;
  timestamp: number;
}

export interface BatchWriterOptions<T> {
  flushIntervalMs?: number;
  maxBatchSize?: number;
  flushFn: (items: T[]) => Promise<void>;
  onError?: (error: Error, items: T[]) => void;
}

export class BatchWriter<T> {
  private buffer: T[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private readonly options: Required<BatchWriterOptions<T>>;

  constructor(options: BatchWriterOptions<T>) {
    this.options = {
      flushIntervalMs: options.flushIntervalMs ?? env.MONGO_BATCH_FLUSH_MS,
      maxBatchSize: options.maxBatchSize ?? env.MONGO_BATCH_MAX_SIZE,
      flushFn: options.flushFn,
      onError: options.onError ?? (() => {}),
    };
  }

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.options.maxBatchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.options.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const batch = this.buffer.splice(0, this.options.maxBatchSize);
    try {
      await this.options.flushFn(batch);
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)), batch);
    } finally {
      this.flushing = false;
      if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.buffer.length > 0) {
      await this.flush();
    }
  }

  get size(): number {
    return this.buffer.length;
  }
}

let traceWriter: BatchWriter<TraceWrite> | undefined;

export function getTraceWriter(flushFn: (items: TraceWrite[]) => Promise<void>): BatchWriter<TraceWrite> {
  if (!traceWriter) {
    traceWriter = new BatchWriter<TraceWrite>({
      flushIntervalMs: env.MONGO_BATCH_FLUSH_MS,
      maxBatchSize: env.MONGO_BATCH_MAX_SIZE,
      flushFn,
      onError: (error, items) => {
        console.warn(`[trace-writer] batch flush failed (${items.length} items):`, error.message);
      },
    });
  }
  return traceWriter;
}

export async function flushTraceWriter(): Promise<void> {
  if (traceWriter) {
    await traceWriter.close();
    traceWriter = undefined;
  }
}

export function createTraceInput(
  input: Omit<TraceWrite, "traceId" | "timestamp"> & { timestamp?: number },
): TraceWrite {
  return {
    ...input,
    traceId: randomUUID(),
    timestamp: input.timestamp ?? Date.now(),
  };
}
