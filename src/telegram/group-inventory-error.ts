export function isClosedGroupTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection closed|not connected|socket\s*(?:is\s*)?closed|websocket\s*(?:is\s*)?closed/i.test(
    message,
  );
}
