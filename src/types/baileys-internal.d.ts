declare module "plogme/lib/Utils/messages.js" {
  export function downloadMediaMessage(
    message: unknown,
    type: "buffer" | "stream",
    options?: Record<string, unknown>,
    context?: unknown,
  ): Promise<Buffer | AsyncIterable<Uint8Array>>;
}

