export type AntiAction = "kick" | "warn" | "delete";

export type AntiModuleKey =
  | "antilink"
  | "antibot"
  | "antispam"
  | "antipic"
  | "antivid"
  | "antiaud"
  | "antivn"
  | "antitxt"
  | "antiemoji"
  | "antisticker"
  | "antigroupcall"
  | "antinsfw"
  | "antigroupmention"
  | "antigm"
  | "antiwords"
  | "antipoll"
  | "antiforward"
  | "antichannel"
  | "antipromote"
  | "antidemote"
  | "antigstatus";

export type MessageAntiModuleKey = Exclude<
  AntiModuleKey,
  "antipromote" | "antidemote"
>;

export type AntiCapability = "supported" | "local-only" | "unavailable";

export type GroupSecurityMode =
  | "off"
  | "restore"
  | "restorewarn"
  | "restorekick"
  | "restoreban"
  | "revert"
  | "warn"
  | "kick"
  | "ban"
  | "knp"
  | "kwp"
  | "dnp"
  | "dwp"
  | "jw"
  | "wnp"
  | "d/p"
  | "d/d"
  | "p/p"
  | "p/k"
  | `restorewarn:${number}`;

export type TargetMode = "protected" | "admins";

export interface AntiModuleConfig {
  enabled: boolean;
  action: AntiAction;
  warnThreshold: number;
  permitList: string[];
  customMessage?: string;
  capability?: AntiCapability;
  capabilityReason?: string;
}

export interface AntiSpamConfig extends AntiModuleConfig {
  messageLimit: number;
  windowSeconds: number;
}

export interface AntiWordsConfig extends AntiModuleConfig {
  words: string[];
}

export interface SecurityModuleConfig extends AntiModuleConfig {
  mode: GroupSecurityMode;
  targetMode: TargetMode;
}

export interface GroupAntiConfig {
  schemaVersion: 1;
  workspaceId: string;
  sessionId: string;
  groupJid: string;
  antilink?: AntiModuleConfig;
  antibot?: AntiModuleConfig;
  antispam?: AntiSpamConfig;
  antipic?: AntiModuleConfig;
  antivid?: AntiModuleConfig;
  antiaud?: AntiModuleConfig;
  antivn?: AntiModuleConfig;
  antitxt?: AntiModuleConfig;
  antiemoji?: AntiModuleConfig;
  antisticker?: AntiModuleConfig;
  antigroupcall?: AntiModuleConfig;
  antinsfw?: AntiModuleConfig;
  antigroupmention?: AntiModuleConfig;
  antigm?: AntiModuleConfig;
  antiwords?: AntiWordsConfig;
  antipoll?: AntiModuleConfig;
  antiforward?: AntiModuleConfig;
  antichannel?: AntiModuleConfig;
  antipromote?: SecurityModuleConfig;
  antidemote?: SecurityModuleConfig;
  antigstatus?: AntiModuleConfig;
  silentActionMessages: boolean;
  messages: Record<string, string>;
  updatedAt: number;
}

export type AntiStore = Record<string, GroupAntiConfig>;

export interface AntiInboundMessage {
  workspaceId: string;
  sessionId: string;
  groupJid: string;
  messageId?: string;
  senderJid: string;
  fromMe?: boolean;
  text: string;
  prefix?: string;
  message?: Record<string, unknown>;
  quotedText?: string;
  mentionedJids?: string[];
  mediaKind?: "image" | "video" | "audio" | "document" | "sticker";
  mediaPtt?: boolean;
  rawKey?: Record<string, unknown>;
}

export interface AntiParticipantEvent {
  workspaceId: string;
  sessionId: string;
  groupJid: string;
  messageId?: string;
  participants: string[];
  action: "promote" | "demote";
  author?: string;
}

export interface AntiGroupMetadata {
  isBotAdmin: boolean;
  admins: Set<string>;
  botJids: Set<string>;
  protectedJids: Set<string>;
}

export interface AntiDecision {
  module: AntiModuleKey;
  detected: boolean;
  reason?: string;
  exempted?: boolean;
  action?: AntiAction;
  warningCount?: number;
}

export interface AntiStatusRow {
  key: AntiModuleKey;
  enabled: boolean;
  action: AntiAction | GroupSecurityMode;
  capability: AntiCapability;
  reason?: string;
  permitCount: number;
}
