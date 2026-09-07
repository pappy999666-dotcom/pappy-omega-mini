import { afterEach, describe, expect, it } from "vitest";
import {
  _expireDigitalConfirmToken,
  isDigitalConfirmInteractionId,
  parseDigitalConfirmInteractionId,
  peekDigitalConfirmTap,
  pendingDigitalConfirmCount,
  registerDigitalConfirmAction,
  renderDigitalConfirmCardForToken,
  renderDigitalConfirmHtml,
  renderDigitalConfirmReply,
  resetDigitalConfirmState,
  resolveDigitalConfirmByToken,
  resolveDigitalConfirmTap,
  unregisterDigitalConfirmAction,
} from "../src/whatsapp/digital-confirm.js";

const BASE = {
  workspaceId: "workspace-a",
  sessionId: "session-1",
  chatJid: "120363000000000000@g.us",
};

const OWNER = "15550001111@s.whatsapp.net";
const OTHER = "15550002222@s.whatsapp.net";

afterEach(() => {
  resetDigitalConfirmState();
});

describe("renderDigitalConfirmReply", () => {
  it("renders native-flow buttons with a routable token id in rich mode", () => {
    const rendered = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "approve user", promptText: "Approve this user?" },
      responseType: "rich",
      prefix: ".",
    });

    expect(rendered.content.text).toBe("Approve this user?");
    expect(rendered.content.nativeFlow).toHaveLength(2);
    const confirm = rendered.content.nativeFlow?.[0];
    const cancel = rendered.content.nativeFlow?.[1];
    expect(confirm?.text).toBe("✅ Confirm");
    expect(cancel?.text).toBe("✖ Cancel");
    const parsed = confirm?.id ? parseDigitalConfirmInteractionId(confirm.id) : undefined;
    expect(parsed?.decision).toBe("confirm");
    expect(parsed?.token).toBe(rendered.token);
    expect(confirm?.id).toMatch(/^dc:confirm:[a-z0-9-]+$/u);
    expect(cancel?.id).toMatch(/^dc:cancel:[a-z0-9-]+$/u);
  });

  it("renders a typed-answer prompt in traditional mode and still registers a token", () => {
    const rendered = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "approve", promptText: "Approve this user?" },
      responseType: "traditional",
      prefix: "!",
    });

    expect(rendered.content.nativeFlow).toBeUndefined();
    expect(rendered.content.text).toContain("Approve this user?");
    expect(rendered.content.text).toContain(`!dc ${rendered.token} yes`);
    expect(pendingDigitalConfirmCount()).toBe(1);
  });

  it("distinguishes custom labels and binds each prompt to its own token", () => {
    const first = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: {
        action: "delete",
        promptText: "Delete the file?",
        confirmLabel: "🗑 Delete",
        cancelLabel: "Keep",
      },
      responseType: "rich",
    });
    const second = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OTHER,
      definition: { action: "delete", promptText: "Delete another file?" },
      responseType: "rich",
    });

    expect(first.content.nativeFlow?.[0]?.text).toBe("🗑 Delete");
    expect(first.content.nativeFlow?.[1]?.text).toBe("Keep");
    expect(first.token).not.toBe(second.token);
    expect(pendingDigitalConfirmCount()).toBe(2);
  });
});

describe("resolveDigitalConfirmTap", () => {
  it("runs the registered action for the initiator's confirm tap, once only", async () => {
    const calls: string[] = [];
    registerDigitalConfirmAction("approve", async (payload) => {
      calls.push(String(payload?.target ?? ""));
      return "✅ Approved.";
    });
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "approve", promptText: "Approve?", payload: { target: "user-9" } },
      responseType: "rich",
    });

    const outcome = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toBe("✅ Approved.");
    expect(calls).toEqual(["user-9"]);

    // One-shot: a second tap cannot run the action again.
    const second = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(second.status).toBe("expired");
    expect(calls).toHaveLength(1);
  });

  it("rejects taps from a different user as unauthorized without consuming", async () => {
    const calls: string[] = [];
    registerDigitalConfirmAction("approve", () => {
      calls.push("ran");
      return "ok";
    });
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "approve", promptText: "Approve?" },
      responseType: "rich",
    });

    const outcome = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "confirm",
      senderJid: OTHER,
    });
    expect(outcome.status).toBe("unauthorized");
    expect(outcome.reply).toMatch(/Unauthorized/u);
    expect(calls).toHaveLength(0);

    // The prompt is still live for the real initiator afterwards.
    const ownerTap = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(ownerTap.status).toBe("ok");
  });

  it("cancels without invoking the action handler", async () => {
    const calls: string[] = [];
    registerDigitalConfirmAction("delete", () => {
      calls.push("ran");
      return "deleted";
    });
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "delete", promptText: "Delete?" },
      responseType: "rich",
    });

    const outcome = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "cancel",
      senderJid: OWNER,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toMatch(/Cancelled/u);
    expect(calls).toHaveLength(0);
  });

  it("is scoped to the originating chat and reports unknown tokens", async () => {
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "kick", promptText: "Kick?" },
      responseType: "rich",
    });

    const otherChat = await resolveDigitalConfirmTap({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      chatJid: "15559999999@s.whatsapp.net",
      token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(otherChat.status).toBe("not-found");

    const unknown = await resolveDigitalConfirmTap({
      ...BASE,
      token: "nope0000000000",
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(unknown.status).toBe("not-found");
  });
});

describe("HTML confirm/cancel container", () => {
  it("renders the morphing HTML with .cc beacons and runs the action by token", async () => {
    const calls: string[] = [];
    registerDigitalConfirmAction("approve", () => {
      calls.push("ran");
      return "✅ Approved";
    });
    const rendered = renderDigitalConfirmHtml({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      chatJid: BASE.chatJid,
      initiatorJid: OWNER,
      definition: { action: "approve", promptText: "Approve user #42?" },
      botNumber: "15550009999",
    });
    expect(rendered.html).toContain("✅ Confirmed");
    expect(rendered.html).toContain("✖ Cancelled");
    expect(rendered.html).toContain("wa.me/15550009999?text=");
    expect(rendered.html).toContain(`.cc%20${rendered.token}%20yes`);
    expect(rendered.html).toContain(`.cc%20${rendered.token}%20no`);
    expect(rendered.html).not.toContain("nativeFlowMessage");

    // Beacon arrives from the owner's DM — different chatJid than the prompt.
    const outcome = await resolveDigitalConfirmByToken({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      token: rendered.token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.reply).toBe("✅ Approved");
    expect(calls).toEqual(["ran"]);
  });

  it("is one-shot across the HTML beacon channel", async () => {
    const calls: string[] = [];
    registerDigitalConfirmAction("delete", () => {
      calls.push("ran");
      return "deleted";
    });
    const rendered = renderDigitalConfirmHtml({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      chatJid: BASE.chatJid,
      initiatorJid: OWNER,
      definition: { action: "delete", promptText: "Delete?" },
      botNumber: "15550009999",
    });
    await resolveDigitalConfirmByToken({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      token: rendered.token,
      decision: "cancel",
      senderJid: OWNER,
    });
    const second = await resolveDigitalConfirmByToken({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      token: rendered.token,
      decision: "cancel",
      senderJid: OWNER,
    });    expect(second.status).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  it("pairs the card with the deck token — one pending entry answers both channels", async () => {
    const calls: string[] = [];
    registerDigitalConfirmAction("pair", () => {
      calls.push("ran");
      return "paired";
    });
    const definition = { action: "pair", promptText: "Pair this session?" };
    const deck = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition,
      responseType: "rich",
      prefix: ".",
    });
    const html = renderDigitalConfirmCardForToken({
      definition,
      botNumber: "15550009999",
      token: deck.token,
    });
    expect(html).toContain("PAPPY OS · CONFIRM");
    expect(html).toContain("wa.me/15550009999?text=");
    expect(html).toContain(`.cc%20${deck.token}%20yes`);

    // The card's .cc beacon resolves the SAME pending entry the deck
    // registered — tapping either channel executes the action once.
    const viaBeacon = await resolveDigitalConfirmByToken({
      workspaceId: BASE.workspaceId,
      sessionId: BASE.sessionId,
      token: deck.token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(viaBeacon.status).toBe("ok");
    expect(viaBeacon.reply).toBe("paired");
    expect(calls).toEqual(["ran"]);

    // One-shot: the deck button now reports the entry answered.
    const viaDeck = await resolveDigitalConfirmTap({
      ...BASE,
      token: deck.token,
      decision: "cancel",
      senderJid: OWNER,
    });
    expect(viaDeck.status).toBe("expired");
  });

});

describe("id helpers + peek", () => {
  it("recognizes only digital-confirm interaction ids", () => {
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "mod", promptText: "Mod?" },
      responseType: "rich",
    });
    expect(isDigitalConfirmInteractionId(`dc:confirm:${token}`)).toBe(true);
    expect(isDigitalConfirmInteractionId(`dc:cancel:${token}`)).toBe(true);
    expect(isDigitalConfirmInteractionId("group-control:confirm:token1")).toBe(false);
    expect(isDigitalConfirmInteractionId("game:spin")).toBe(false);
  });

  it("peeks validity without consuming, for the unauthorized-tap notice", async () => {
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "mod", promptText: "Mod?" },
      responseType: "traditional",
    });
    const peek = peekDigitalConfirmTap({ ...BASE, token });
    expect(peek.valid).toBe(true);

    // Consume it; peek then reports invalid so strangers stay silent.
    await resolveDigitalConfirmTap({ ...BASE, token, decision: "confirm", senderJid: OWNER });
    expect(peekDigitalConfirmTap({ ...BASE, token }).valid).toBe(false);
  });

  it("expires prompts after their TTL", async () => {
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "mod", promptText: "Mod?" },
      responseType: "rich",
    });
    expect(peekDigitalConfirmTap({ ...BASE, token }).valid).toBe(true);

    _expireDigitalConfirmToken({ ...BASE, token });
    expect(peekDigitalConfirmTap({ ...BASE, token }).valid).toBe(false);
    const outcome = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(outcome.status).toBe("not-found");
  });

  it("unregisters action handlers", async () => {
    registerDigitalConfirmAction("temp", () => "ok");
    unregisterDigitalConfirmAction("temp");
    const { token } = renderDigitalConfirmReply({
      ...BASE,
      initiatorJid: OWNER,
      definition: { action: "temp", promptText: "Temp?" },
      responseType: "rich",
    });
    const outcome = await resolveDigitalConfirmTap({
      ...BASE,
      token,
      decision: "confirm",
      senderJid: OWNER,
    });
    expect(outcome.reply).toMatch(/No action handler is registered/u);
  });
});
