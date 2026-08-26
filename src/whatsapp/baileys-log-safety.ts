function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function messageText(inputArgs: unknown[]): string {
  return inputArgs
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (!value || typeof value !== "object") return String(value ?? "");
      const record = value as Record<string, unknown>;
      const error = record.error && typeof record.error === "object"
        ? record.error as Record<string, unknown>
        : undefined;
      const err = record.err && typeof record.err === "object"
        ? record.err as Record<string, unknown>
        : undefined;
      return [
        record.msg,
        record.message,
        record.name,
        error?.message,
        error?.name,
        err?.message,
        err?.name,
      ]
        .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .join(" ");
    })
    .join(" ")
    .slice(0, 2_000);
}

export function isNoisyBaileysProtocolLog(inputArgs: unknown[]): boolean {
  const lower = messageText(inputArgs).toLowerCase();
  const hasProtocolNode = inputArgs.some((value) => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return ["node", "fullErrorNode", "reasonNode", "payloadNode", "child"].some((key) => key in record);
  });
  return hasProtocolNode || lower.includes("mex newsletter") || lower.includes("newsletter notification");
}

/**
 * Keep the event name and scalar error metadata, but never pass protocol nodes,
 * payloads, binary strings, or media buffers through to Pino for noisy
 * newsletter/protocol diagnostics. This affects logging only; event handling is
 * unchanged.
 */
export function sanitizeNoisyBaileysLogArgs(inputArgs: unknown[]): unknown[] {
  const message = messageText(inputArgs);
  const statusCodes: number[] = [];
  const errorNames: string[] = [];
  const errorMessages: string[] = [];
  for (const value of inputArgs) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const candidates = [record, record.error, record.err].filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
    );
    for (const candidate of candidates) {
      const code = scalar(candidate.statusCode);
      if (typeof code === "number") statusCodes.push(code);
      const output = candidate.output;
      if (output && typeof output === "object") {
        const outputRecord = output as Record<string, unknown>;
        const outputCode = scalar(outputRecord.statusCode);
        if (typeof outputCode === "number") statusCodes.push(outputCode);
      }
      const name = scalar(candidate.name);
      if (typeof name === "string") errorNames.push(name.slice(0, 120));
      const errorMessage = scalar(candidate.message);
      if (typeof errorMessage === "string") errorMessages.push(errorMessage.slice(0, 240));
    }
  }
  return [{
    event: "baileys-protocol-log",
    message,
    ...(statusCodes.length ? { statusCodes: [...new Set(statusCodes)] } : {}),
    ...(errorNames.length ? { errorNames: [...new Set(errorNames)] } : {}),
    ...(errorMessages.length ? { errorMessages: [...new Set(errorMessages)] } : {}),
  }];
}
