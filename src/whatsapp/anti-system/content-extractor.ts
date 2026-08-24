type AnyRecord = Record<string, unknown>;

const WRAPPERS = [
  "associatedChildMessage",
  "botForwardedMessage",
  "botInvokeMessage",
  "botTaskMessage",
  "documentWithCaptionMessage",
  "editedMessage",
  "ephemeralMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
  "statusMentionMessage",
  "statusMentionReply",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
] as const;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addText(out: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) out.push(value);
}

function addListText(out: string[], value: AnyRecord): void {
  addText(out, value.title);
  addText(out, value.description);
  for (const section of Array.isArray(value.sections) ? value.sections : []) {
    if (!isRecord(section)) continue;
    addText(out, section.title);
    for (const row of Array.isArray(section.rows) ? section.rows : []) {
      if (!isRecord(row)) continue;
      addText(out, row.title);
      addText(out, row.description);
    }
  }
}

function addPollText(out: string[], value: AnyRecord): void {
  addText(out, value.name);
  for (const option of Array.isArray(value.options) ? value.options : []) {
    if (isRecord(option)) addText(out, option.optionName ?? option.name ?? option.title ?? option.text);
    else addText(out, option);
  }
  for (const option of Array.isArray(value.selectableOptions) ? value.selectableOptions : []) {
    if (isRecord(option)) addText(out, option.optionName ?? option.name ?? option.title ?? option.text);
    else addText(out, option);
  }
}

function collect(node: AnyRecord, out: string[], seen: Set<object>, depth: number): void {
  if (depth > 16 || seen.has(node)) return;
  seen.add(node);

  addText(out, node.conversation);

  if (isRecord(node.extendedTextMessage)) {
    const extended = node.extendedTextMessage;
    addText(out, extended.text);
    addText(out, extended.matchedText);
    addText(out, extended.canonicalUrl);
    addText(out, extended.title);
    addText(out, extended.description);
  }

  for (const key of ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]) {
    if (isRecord(node[key])) addText(out, node[key].caption);
  }

  if (isRecord(node.buttonsMessage)) addText(out, node.buttonsMessage.contentText);
  if (isRecord(node.buttonsResponseMessage)) {
    addText(out, node.buttonsResponseMessage.selectedDisplayText);
    addText(out, node.buttonsResponseMessage.selectedButtonId);
  }
  if (isRecord(node.listMessage)) addListText(out, node.listMessage);
  if (isRecord(node.listResponseMessage) && isRecord(node.listResponseMessage.singleSelectReply)) {
    addText(out, node.listResponseMessage.singleSelectReply.selectedDisplayText);
    addText(out, node.listResponseMessage.singleSelectReply.selectedRowId);
  }
  if (isRecord(node.templateButtonReplyMessage)) {
    addText(out, node.templateButtonReplyMessage.selectedDisplayText);
    addText(out, node.templateButtonReplyMessage.selectedId);
  }
  if (isRecord(node.templateMessage) && isRecord(node.templateMessage.hydratedTemplate))
    addText(out, node.templateMessage.hydratedTemplate.hydratedContentText);

  if (isRecord(node.interactiveMessage)) {
    for (const key of ["header", "body", "footer"]) {
      const part = node.interactiveMessage[key];
      if (isRecord(part)) {
        addText(out, part.text);
        addText(out, part.title);
      }
    }
  }
  if (isRecord(node.interactiveResponseMessage)) {
    if (isRecord(node.interactiveResponseMessage.body)) addText(out, node.interactiveResponseMessage.body.text);
    if (isRecord(node.interactiveResponseMessage.nativeFlowResponseMessage))
      addText(out, node.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
  }

  for (const key of ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3", "pollUpdateMessage"]) {
    if (isRecord(node[key])) addPollText(out, node[key]);
  }

  if (isRecord(node.protocolMessage) && isRecord(node.protocolMessage.editedMessage))
    collect(node.protocolMessage.editedMessage, out, seen, depth + 1);

  for (const key of WRAPPERS) {
    const wrapper = node[key];
    if (!isRecord(wrapper)) continue;
    if (isRecord(wrapper.message)) collect(wrapper.message, out, seen, depth + 1);
    else collect(wrapper, out, seen, depth + 1);
  }
}

export function extractSenderTexts(message: Record<string, unknown> | undefined): string[] {
  if (!message) return [];
  const out: string[] = [];
  collect(message, out, new Set<object>(), 0);
  return out;
}

export function extractSenderText(message: Record<string, unknown> | undefined): string {
  return extractSenderTexts(message).join("\n");
}

const URL_CANDIDATE_RE = /(?:https?|ftp):\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?<![\w@.-])(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9_-]{1,62}(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?/giu;
const TRAILING_PUNCTUATION = /[.,!?;:'"…。！？、，；：）】』》]$/u;

function normalizeCandidate(raw: string): string | undefined {
  let candidate = raw;
  while (TRAILING_PUNCTUATION.test(candidate)) candidate = candidate.slice(0, -1);
  const parsedValue = /^(?:https?|ftp):\/\//iu.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const parsed = new URL(parsedValue);
    if (!["http:", "https:", "ftp:"].includes(parsed.protocol)) return undefined;
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (!hostname || !hostname.includes(".")) return undefined;
    const labels = hostname.split(".");
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/iu.test(label))) return undefined;
    const tld = labels[labels.length - 1] ?? "";
    if (tld.length < 2 || tld.length > 63 || !/^[a-z][a-z0-9_-]*$/iu.test(tld)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

export function extractSenderLinks(message: Record<string, unknown> | undefined): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const text of extractSenderTexts(message)) {
    URL_CANDIDATE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_CANDIDATE_RE.exec(text)) !== null) {
      const normalized = normalizeCandidate(match[0]);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(normalized);
    }
  }
  URL_CANDIDATE_RE.lastIndex = 0;
  return found;
}
