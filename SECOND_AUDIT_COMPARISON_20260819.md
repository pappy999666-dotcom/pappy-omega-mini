# Second comparison after implementation

| Area | Before | After | Remaining review |
|---|---|---|---|
| Universal previews | Explicit HTTP(S) only; media captions skipped | Safe bare-domain extraction, canonical generic metadata resolution, caption-bearing image/video/document previews, SSRF/caching preserved | Validate live clients for unusual domains and unsupported metadata |
| Admin Global Bridge | Long UUID callback payloads and no true cross-workspace fan-out | Short token callbacks, select/open/clear/send controls, bounded sequential fan-out, explicit unknown-command outcome | Live Telegram click smoke test remains user-facing |
| Telegram pending flows | Slash commands bypassed but did not cancel stale pending state | New slash commands clear all pending maps; callbacks clear maps before next flow; Cancel is explicit | Exercise every guided flow manually/with callback harness |
| WhatsApp command privacy | Prefix/owner gate existed | Non-command and unknown commands remain silent; authorized bridge routes unknown input as controlled failure | Live owner/sudo smoke test |
| Callback map | Some Admin Bridge payloads exceeded Telegram callback limits | Admin Bridge emitted callbacks are tokenized and tested at <=64 chars | Continue full recursive Omega-v1 parity audit for less frequently used session submenus |
