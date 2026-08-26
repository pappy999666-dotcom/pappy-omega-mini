import { spawn, type ChildProcess } from "node:child_process";

export interface BoundedSubprocessOptions {
  cwd?: string;
  input?: Buffer;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  errorPrefix?: string;
}

export interface BoundedSubprocessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function tailAppend(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, limit: number): Buffer<ArrayBufferLike> {
  if (limit <= 0) return Buffer.alloc(0);
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const combined = Buffer.concat([current, chunk]);
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

function terminate(child: ChildProcess): void {
  if (!child.killed) child.kill("SIGKILL");
}

export function runBoundedSubprocess(
  binary: string,
  args: string[],
  options: BoundedSubprocessOptions,
): Promise<BoundedSubprocessResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? 64 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 8 * 1024;
  const prefix = options.errorPrefix ?? `${binary} failed`;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      terminate(child);
      reject(error);
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitCode === 0) resolve({ stdout, stderr, exitCode, signal });
      else {
        const detail = stderr.toString("utf8").trim().slice(-800);
        reject(new Error(detail || `${prefix}: exited with code ${exitCode ?? "unknown"}${signal ? ` (${signal})` : ""}.`));
      }
    };

    timer = setTimeout(() => fail(new Error(`${prefix} timed out after ${options.timeoutMs}ms.`)), Math.max(1, options.timeoutMs));
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + next.length > maxStdoutBytes) {
        fail(new Error(`${prefix} exceeded the stdout size limit.`));
        return;
      }
      stdout = Buffer.concat([stdout, next]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = tailAppend(stderr, next, maxStderrBytes);
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code, signal) => finish(code, signal));

    if (options.input) {
      child.stdin?.once("error", (error) => fail(error));
      child.stdin?.end(options.input);
    }
  });
}

export async function runBoundedSubprocessText(
  binary: string,
  args: string[],
  options: BoundedSubprocessOptions,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runBoundedSubprocess(binary, args, options);
  return { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}
