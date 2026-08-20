export interface BroadcastReadyMessageInput {
  kind: "allstatus" | "allchat";
  totalGroups: number;
  expectedPosts: number;
  delaySeconds: number;
  expectedMinutes: number;
  expectedSeconds: number;
  jobCode: string;
}

export function formatBroadcastReadyMessage(
  input: BroadcastReadyMessageInput,
): string {
  const label = input.kind === "allstatus" ? "ALL-STATUS" : "ALL-CHAT";
  const action =
    input.kind === "allstatus"
      ? "Status delivery is now posting to every resolved group."
      : "Hidden-member mention delivery is now posting to every resolved group.";
  return [
    `✦ PAPPY OMEGA MINI · ${label} READY`,
    "──────────────────────────────",
    `Total groups  · ${input.totalGroups}`,
    `Expected posts · ${input.expectedPosts}`,
    `Delay         · ${input.delaySeconds}s`,
    `Expected time · ${input.expectedMinutes}m ${input.expectedSeconds}s`,
    `Live code     · ${input.jobCode}`,
    `Action        · ${action}`,
  ].join("\n");
}
