import type {
  CommandContext,
  WhatsAppCommandReply,
} from "./command-registry.js";
import type { GroupControlTable } from "./group-control-confirmation.js";

export interface GameState {
  credits: number;
  bet: number;
  bestWin: number;
  spins: number;
  lastResult: string;
}

export type GameAction = "game" | "spin" | "balance" | "reset" | "help";

const DEFAULT_STATE: GameState = {
  credits: 530,
  bet: 10,
  bestWin: 0,
  spins: 0,
  lastResult: "Good luck",
};

const states = new Map<string, GameState>();

function stateKey(ctx: CommandContext): string {
  return [
    ctx.workspaceId,
    ctx.sessionId,
    ctx.senderJid ?? ctx.chatJid ?? "unknown",
  ].join("\u0000");
}

function cloneDefaultState(): GameState {
  return { ...DEFAULT_STATE };
}

function getState(ctx: CommandContext): GameState {
  const key = stateKey(ctx);
  const existing = states.get(key);
  if (existing) return existing;
  const created = cloneDefaultState();
  states.set(key, created);
  return created;
}

function gameTable(state: GameState): GroupControlTable {
  return {
    title: "FRUIT BONANZA · GAME STATUS",
    headers: ["Metric", "Value"],
    rows: [
      ["Credits", String(state.credits)],
      ["Bet", String(state.bet)],
      ["Best Win", String(state.bestWin)],
      ["Spins", String(state.spins)],
      ["Last result", state.lastResult],
    ],
    buttons: [
      { text: "Spin", id: "game:spin" },
      { text: "Balance", id: "game:balance" },
      { text: "Reset demo", id: "game:reset" },
    ],
    footer: "Demo mode only · no cash value",
  };
}

function richResponse(state: GameState): Array<Record<string, unknown>> {
  return [
    { text: "FRUIT BONANZA\nChoose an action below." },
    {
      title: "Game Status",
      table: [
        { isHeading: true, items: ["Metric", "Value"] },
        { isHeading: false, items: ["Credits", String(state.credits)] },
        { isHeading: false, items: ["Bet", String(state.bet)] },
        { isHeading: false, items: ["Best Win", String(state.bestWin)] },
        { isHeading: false, items: ["Spins", String(state.spins)] },
        { isHeading: false, items: ["Last result", state.lastResult] },
      ],
    },
    { text: "Use the buttons or send .spin, .balance, or .resetgame." },
  ];
}

function response(ctx: CommandContext, state: GameState): WhatsAppCommandReply {
  const table = gameTable(state);
  return {
    text: [
      "FRUIT BONANZA",
      "",
      `Credits: ${state.credits}`,
      `Bet: ${state.bet}`,
      `Best win: ${state.bestWin}`,
      `Spins: ${state.spins}`,
      `Result: ${state.lastResult}`,
    ].join("\n"),
    nativeTable: table,
    nativeFlow: table.buttons,
    richResponse: richResponse(state),
  };
}

function spin(state: GameState): void {
  if (state.credits < state.bet) {
    state.lastResult = "Not enough credits";
    return;
  }

  state.credits -= state.bet;
  state.spins += 1;

  const roll = Math.random();
  const win = roll < 0.05 ? 100 : roll < 0.15 ? 60 : roll < 0.3 ? 20 : 0;
  state.credits += win;
  state.bestWin = Math.max(state.bestWin, win);
  state.lastResult = win > 0 ? `WIN +${win}` : "Loooser";
}

export function runGameAction(
  ctx: CommandContext,
  action: GameAction,
): WhatsAppCommandReply {
  const current = getState(ctx);
  if (action === "reset") {
    states.set(stateKey(ctx), cloneDefaultState());
    return response(ctx, getState(ctx));
  }
  if (action === "spin") spin(current);
  return response(ctx, current);
}

export function runGameCommand(ctx: CommandContext): WhatsAppCommandReply {
  const action = (ctx.args[0]?.toLowerCase() ?? "game") as GameAction;
  if (!["game", "spin", "balance", "reset", "help"].includes(action)) {
    return {
      text: "Usage: .game, .spin, .balance, or .resetgame",
    };
  }
  if (action === "help") {
    return {
      text: "Game commands:\n.game or .balance · show the dashboard\n.spin · play one round\n.resetgame · reset the demo state",
    };
  }
  return runGameAction(
    ctx,
    action === "game" || action === "balance" ? "game" : action,
  );
}

export function resetGamePrototypeState(): void {
  states.clear();
}

export function gamePrototypeStateCount(): number {
  return states.size;
}
