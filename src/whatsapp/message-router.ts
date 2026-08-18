import { executeCommand, createCommandRegistry } from "./command-registry.js";
import { getSession } from "../core/session-registry.js";

const registry = createCommandRegistry();

export interface IncomingTextMessage {
  workspaceId: string;
  sessionId: string;
  senderJid: string;
  text: string;
  quotedText?: string;
}

export async function routeWhatsAppText(
  message: IncomingTextMessage,
): Promise<string | null> {
  const session = getSession(message.workspaceId, message.sessionId);
  const source =
    message.quotedText && !message.text.trim()
      ? message.quotedText
      : message.text;
  const trimmed = source.trim();
  const prefix = session.prefix;
  if (prefix && !trimmed.startsWith(prefix)) return null;
  const raw = prefix ? trimmed.slice(prefix.length) : trimmed;
  if (!raw.trim()) return null;

  const isOwner =
    message.senderJid === session.phoneNumber ||
    session.sudoList.includes(message.senderJid);
  return executeCommand(registry, raw, {
    workspaceId: message.workspaceId,
    sessionId: message.sessionId,
    isOwner,
    args: [],
  });
}
