export interface TelegramFeatureEntry {
  name: string;
  command?: string;
  description: string;
}

export interface TelegramFeatureSection {
  id: string;
  label: string;
  description: string;
  entries: TelegramFeatureEntry[];
}

export const pappyTelegramFeatureSections: TelegramFeatureSection[] = [
  {
    id: "session",
    label: "Session & Profile",
    description: "Pairing, identity, profile, and session configuration.",
    entries: [
      { name: "Pair", command: ".pair", description: "Create or recover a WhatsApp session." },
      { name: "Sessions", description: "Open the isolated session directory." },
      { name: "Ping", command: ".ping", description: "Check session response and transport health." },
      { name: "Profile", command: ".profile", description: "Show session identity, status, prefix, and auto-join state." },
      { name: "Health", command: ".health", description: "Inspect session health and current runtime state." },
      { name: "Prefix", command: ".setprefix", description: "Set a prefix or use none/null for prefixless mode." },
      { name: "PFP", command: ".pfp", description: "Get, set from replied media, or remove the profile picture." },
      { name: "Name", command: ".setname", description: "Update the WhatsApp display name." },
      { name: "Bio", command: ".setbio", description: "Update the WhatsApp profile bio." },
      { name: "Sudo", command: ".setsudo", description: "Manage session-authorized WhatsApp identities." },
    ],
  },
  {
    id: "groups",
    label: "Groups & Join Manager",
    description: "Group inventory, group creation, profile controls, and safe joining.",
    entries: [
      { name: "Groups", command: ".groups", description: "Open the Telegram administrator-group inventory for this WhatsApp session." },
      { name: "Create Group", command: ".creategroup", description: "Create a WhatsApp group from guided input." },
      { name: "Group Picture", command: ".setgpp", description: "Set a group picture from a replied image or HTTPS image URL." },
      { name: "Join Manager", command: ".join", description: "Start the isolated Active-bucket join worker." },
      { name: "Join Target", command: ".targetgs", description: "Set the Active-bucket join target." },
      { name: "Auto-join", command: ".autojoin", description: "Toggle conservative invite-link auto-join handling." },
      { name: "Ignored Groups", command: ".iggc", description: "List, add, or clear session broadcast exclusions." },
    ],
  },
  {
    id: "broadcast",
    label: "Broadcast Network",
    description: "Serial, session-isolated group delivery with durable progress.",
    entries: [
      { name: "All Status", command: ".allstatus", description: "Post to every resolved participating group status." },
      { name: "Designed All Status", command: ".dallstatus", description: "Post group-aware designed statuses with per-group styling." },
      { name: "Repeated All Status", command: ".allstatusx", description: "Repeat all-status delivery per configured payload." },
      { name: "All Chat", command: ".allchat", description: "Send a hidden-mention message to participating groups." },
      { name: "Repeated All Chat", command: ".allchatx", description: "Repeat all-chat delivery per configured payload." },
      { name: "Stop Status", command: ".stopstatus", description: "Cancel active group-status work for the session." },
      { name: "Stop Chat", command: ".stopchat", description: "Cancel active all-chat work for the session." },
      { name: "Broadcast Delay", command: ".broadcastdelay", description: "Read or set the workspace-wide pacing in seconds." },
    ],
  },
  {
    id: "status",
    label: "Status & Tagging",
    description: "Personal status, group status, and member-tagging actions.",
    entries: [
      { name: "Personal Status", command: ".pstatus", description: "Post text or replied media to personal WhatsApp Status." },
      { name: "Group Status", command: ".gstatus", description: "Post plain text to the current group status." },
      { name: "Designed Group Status", command: ".dgstatus", description: "Post a group-aware designed status with a color background." },
      { name: "Repeated Group Status", command: ".gstatusx", description: "Repeat a group-status post." },
      { name: "Hidden Tag", command: ".tag", description: "Send a hidden-mention group message." },
      { name: "Visible Tag", command: ".stag", description: "Send a visible member-mention group message." },
      { name: "Stop Tag", command: ".stopstag", description: "Cancel active tag delivery for the session." },
    ],
  },
  {
    id: "diagnostics",
    label: "Support & Diagnostics",
    description: "Support intake, link-preview inspection, and operational help.",
    entries: [
      { name: "Preview Debug", command: ".previewdebug", description: "Inspect canonical link-preview resolution for a URL." },
      { name: "Support", command: ".support", description: "Open a support ticket from WhatsApp." },
      { name: "Menu", command: ".menu", description: "Open the styled WhatsApp command menu." },
      { name: "Help", command: ".help", description: "Open the WhatsApp command help surface." },
    ],
  },
];

export const omegaUnsupportedTelegramFeatures = [
  { feature: "Game API", omegaSurface: "session:<id>:gameapi", reason: "No PAPPY Game API service or credential store exists." },
  { feature: "AI Group", omegaSurface: "session:<id>:aigroup", reason: "No PAPPY Meta AI group transport workflow exists." },
  { feature: "Plugins", omegaSurface: "session:<id>:plugins", reason: "No PAPPY plugin registry or sandbox exists." },
  { feature: "Smart Promotion", omegaSurface: "session:<id>:smartpromo", reason: "PAPPY has Auto Promote, but not Omega’s separate multi-step Smart Promotion engine." },
  { feature: "Tutorial Content", omegaSurface: "admin:tutorials", reason: "PAPPY has no tutorial-media persistence and preview workflow." },
  { feature: "Release Controls", omegaSurface: "admin:release:menu", reason: "PAPPY release deployment is managed by the control-plane deployment path, not a Telegram self-update panel." },
  { feature: "Menu URL Manager", omegaSurface: "admin:menuurl", reason: "PAPPY does not currently persist custom Telegram menu buttons." },
  { feature: "Idea Inbox", omegaSurface: "admin:ideas", reason: "PAPPY has support tickets but no separate idea lifecycle and reply store." },
  { feature: "Omega Group Moderation Dashboard", omegaSurface: "gcset:<session>:<group>", reason: "PAPPY exposes canonical group metadata, picture, invite, edit, and leave controls; member moderation and join-approval subflows are not implemented in the transport adapter." },
];
