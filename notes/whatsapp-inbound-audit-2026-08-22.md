# WhatsApp inbound audit — 2026-08-22

## Scope
Read-only audit of active panel session Pappy. No WhatsApp messages, broadcasts, pairing, purge, or session deletion were performed.

## Live findings
- `pappy-omega-mini.service` and `pappy-panel-v3.service` were queried while the control listener was expected to be live.
- The active session record remains `ACTIVE` with `authHealth: VALID`; the assignment remains `RUNNING` for worker `3d45149e-a536-42b3-9363-870af82d68dd`.
- The panel log shows one assigned session and recurring fresh heartbeat/control reports. It also reports a cached group inventory of 56 groups and 8,210 total members through the non-sending internal inventory diagnostic.
- The panel log contains Baileys `No session found to decrypt message` errors for an unrelated group message and `WhatsApp requested socket restart` entries. These prove transport noise/reconnect activity but do not prove the command parser is rejecting the user command.
- The non-sending inventory diagnostic succeeded: `{ok:true,totalGroups:56,totalMembers:8210,zeroMemberGroups:0}`. Therefore the panel socket is reachable and can query WhatsApp group metadata.

## Source route map
1. Panel Baileys `messages.upsert` calls `emitInbound(runtime, message)`.
2. `emitInbound` extracts text/quoted text/media, preserves `fromMe`, and posts `/workload/event` with workspace/session/message identifiers.
3. Control server authenticates the worker, verifies exact assignment workspace, and calls `handleWorkloadInboundEvent`.
4. The registered index handler invokes `routeWhatsAppText`.
5. For panel-assigned sessions, `shouldProxyWhatsAppSession` intentionally returns false when the session has `workloadWorkerId`; command execution therefore remains on the control plane and its workload transport sends replies back to the panel.
6. `emitInbound` currently drops messages only when there is no text and no quoted text, or when traffic is paused. `fromMe` is preserved and router authorization treats `fromMe === true` as owner authorization.

## Current conclusion
The socket/assignment/control plane is not globally dead. The unresolved question requires one real inbound command event or a user-provided recent message ID/timestamp: whether the panel is receiving the user’s command, whether `/workload/event` returns an error, whether `routeWhatsAppText` returns null, or whether the reply transport fails. Do not send a test message without explicit approval.

## Guardrails
- Do not delete/purge/re-pair the session.
- Do not restart the panel auth state.
- Preserve the nonblocking `void bot.launch()` startup fix and 8788 listener.
- Do not alter broadcast/Telegram code unless the traced failure proves a shared regression.

## Release 1.2.66 post-deploy evidence
- Release 1.2.66 compiled, worker bundle syntax-checked, and the full local suite passed 160/160.
- Deployment used an on-host backup and restarted only `pappy-omega-mini.service`; `pappy-panel-v3.service` was not restarted and its auth directory was not touched.
- The initial 3-second post-restart probe occurred while the control process was still starting; the service log then showed `workload control listening on 127.0.0.1:8788`.
- The existing panel detected and safely applied verified release 1.2.66, restarted its worker process, restored the Pappy session, and refreshed the 56-group inventory. Its matrix remained one assigned session with no reported error after recovery.
- During control shutdown, systemd reached its 30-second stop timeout and killed the old control process. This is an operational risk for future releases because locally hosted sessions can experience a longer restart gap; the panel-hosted session recovered independently. No WhatsApp message or broadcast was sent.
- One remote aggregate probe was malformed by shell interpolation and produced only a diagnostic syntax error; it did not modify data.

## Release 1.2.67 final live re-audit
The control health endpoint returned `ok: true`, control version 1, heartbeat interval 20 seconds, and package version 1.2.67. Both `pappy-omega-mini.service` and `pappy-panel-v3.service` were active with zero systemd restarts. The panel auto-updated to verified release 1.2.67, restarted safely, restored one assigned session, and recovered the 56-group inventory. A transient WhatsApp socket restart and one invalid group metadata response were visible, but the panel recovered and returned to `ERROR none`; one 502 occurred during the expected auto-update/control restart window and was followed by healthy heartbeats.

The final database snapshot showed 8 ACTIVE sessions, 0 LOGGED_OUT sessions, 1 RUNNING assignment, 0 LEASED commands at the initial post-release check and 1 transient lease during the final check; expired commands increased as the new sweeper processed abandoned records. Resource evidence was approximately 2.97 load average, 4.4 GB available memory, and 46 percent root disk usage. No WhatsApp message or broadcast was sent by this audit.
