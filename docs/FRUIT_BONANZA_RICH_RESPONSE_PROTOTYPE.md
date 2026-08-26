# Fruit Bonanza Rich-Response Prototype

This prototype adds a first WhatsApp game surface to PAPPY OMEGA MINI using the existing Baileys command router.

## What it provides

The bot exposes `.game`, `.fruitbonanza`, `.spin`, `.balance`, and `.resetgame`. The response contains a structured status table with credits, bet, best win, spin count, and the last result. It also includes stable interaction IDs: `game:spin`, `game:balance`, and `game:reset`.

The rich-response payload is intentionally paired with the existing `nativeTable` and `nativeFlow` abstractions. That gives the sender pipeline a compatibility path for the project’s current native-table transport while allowing the fork-specific `richResponse` payload to be tested with compatible WhatsApp clients.

## Interaction flow

1. The authorized WhatsApp user sends `.game` or taps a game action.
2. The router resolves the command or native interaction ID.
3. The demo game engine applies the action and updates the player state.
4. The bot sends a new dashboard response with the updated table and rich-response sections.

## Current state model

The first version stores state in memory and isolates it by workspace, WhatsApp session, and sender JID. State is therefore suitable for a prototype but will be lost when the process restarts. Before production use, move `GameState` into the project’s persistence layer and make spin updates atomic.

The current spin logic is a demonstration only. It has no cash value, payment integration, anti-abuse controls, or audited randomness. Do not connect it to real-money wagering without a separate compliance, legal, security, and fairness review.

## Test and build

```bash
npm run typecheck
npm test
npm run build
```

The focused tests are in `tests/whatsapp-game-prototype.test.ts`.

## Next implementation step

To match the supplied recordings more closely, add a separate web game route for animated reels and use the WhatsApp rich response as the account/status surface. The server should remain authoritative for balances and results; the browser animation must never be trusted to decide the outcome.
