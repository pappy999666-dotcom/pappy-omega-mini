# Pappy Session Recovery Incident — 2026-08-19

The paired session `4efde35b-d609-4cf1-879d-4d9dd0cc1eda` appeared dead after the sharpening release. The persisted credential file remained present under the externalized storage tree; no new authentication deletion occurred.

At `12:24:00`, Pappy logged `startup recovery did not reach ACTIVE` for the paired session. The process remained PM2-online, but the WhatsApp session had no subsequent inbound traffic, so the user-visible state was effectively offline/PAIRING.

A Pappy-only clean PM2 restart was performed with the persistent storage symlink intact. At `12:26:30`, logs showed `WhatsApp authenticated open` for the paired session, followed by inbound traffic and an `ACTIVE` heartbeat. The paired credential remained present.

The earlier `smax-invalid (479)` entries in the log are historical events from before the current clean recovery; no new paired-session `smax-invalid` was observed during this recovery window. The new sharpening code was not identified as the disconnect cause. The live preview test remains paused until the session proves stable over a longer observation window.

## Follow-up after preview reset deployment

The first live `.gstatus` attempt after the preview reset exposed a production dependency gap: the installed Baileys fork dynamically imports `link-preview-js`, but the dedicated Pappy dependency tree did not expose it. The command still reached the WhatsApp transport, but Baileys logged `ERR_MODULE_NOT_FOUND` while generating a native URL preview. `link-preview-js` was added as a direct runtime dependency and installed in the dedicated Pappy dependency tree only.

A second restart showed the paired session could receive traffic before restart but again failed to become ACTIVE after restart. Code inspection identified a restart race: if the previous PM2 process still held the Redis session lock, `openWhatsAppSession()` updated the session to `RECONNECTING` and returned without scheduling any retry. The lock expires, but no new start was triggered. The recovery path now schedules the standard exponential reconnect whenever lock acquisition fails.
