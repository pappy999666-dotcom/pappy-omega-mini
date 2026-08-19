from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ui = (ROOT / "src/telegram/ui.ts").read_text()
bot = (ROOT / "src/telegram/bot.ts").read_text()
router = (ROOT / "src/whatsapp/message-router.ts").read_text()
preview = (ROOT / "src/whatsapp/baileys-native-preview.ts").read_text()

literal_callbacks = sorted(set(re.findall(r'btn\([^\n]*?,\s*["`]([^"`]+)["`]', ui)))
# Include template callback fragments so the audit records dynamic namespaces.
template_callbacks = sorted(set(re.findall(r'btn\([^\n]*?,\s*`([^`]+)`', ui)))
handlers = sorted(set(re.findall(r'bot\.action\((?:"([^"]+)"|/([^/]+)/)', bot)))
handlers_flat = sorted(set(a or b for a, b in handlers))

print("# Callback Contract Audit")
print("\n## Static callback literals")
for item in literal_callbacks:
    print(f"- {item}")
print("\n## Dynamic callback templates")
for item in template_callbacks:
    print(f"- {item}")
print("\n## Registered bot.action handlers")
for item in handlers_flat:
    print(f"- {item}")

print("\n## High-risk state markers")
for label, text, patterns in [
    ("pending maps", bot, [r"const pending[A-Za-z0-9]+", r"clearPendingInputs", r"passiveIntakeSuspended"]),
    ("WhatsApp command gate", router, [r"isOwnerFor", r"Unknown command", r"return null", r"prefix"]),
    ("preview eligibility", preview, [r"URL_PATTERN", r"hasMedia", r"firstHttpUrl", r"prepareCanonicalPreviewContent"]),
]:
    print(f"\n### {label}")
    for pattern in patterns:
        matches = list(re.finditer(pattern, text))
        print(f"- `{pattern}`: {len(matches)}")

print("\n## Manual audit rule")
print("Dynamic callback templates require recursive handler inspection; this script is a discovery aid, not a proof of correctness.")
