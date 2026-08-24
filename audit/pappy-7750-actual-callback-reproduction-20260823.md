# Pappy 7750 Actual Telegram Callback Reproduction — 2026-08-23

The first synthetic harness attempt used the wrong bot factory and then contacted Telegram because Telegraf’s client API boundary was not intercepted. Those attempts were not treated as UI evidence.

After correcting the harness to use the deployed `createTelegramBot` factory and intercept Telegraf’s Telegram client prototype, the actual production callback handlers ran locally against live Pappy session state without external Telegram calls.

The exact session-panel route `session:<session>:section:groups` rendered the My Groups message and produced a real group-view callback. The first run took approximately 29.2 seconds before rendering the list; the extracted group callback then executed in approximately 7 ms and rendered Group Detail with its action keyboard. This proves the group click handler itself can render, while also proving the user-visible slowness is in the list inventory step, not only in raw metadata transport.

The earlier direct `session:<session>:groups:0` route also rendered a list and opened its first group, but it was not the exact session-panel route and therefore was superseded by the `section:groups` reproduction.

The next safe fix is to warm the worker’s group-summary cache at session open and share that same fetched inventory with the broadcast cache, avoiding two independent full `groupFetchAllParticipating()` scans. The Telegram handler’s legacy numeric-index fallback must also be removed so an expired callback cannot trigger another slow inventory fetch or map a stale button to a different group.
