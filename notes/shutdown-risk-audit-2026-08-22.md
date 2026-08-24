# Control-plane shutdown risk audit

The prior 1.2.65-to-1.2.66 restart received SIGTERM at 13:18:31 and reached the systemd 30-second stop timeout at 13:19:01, after which systemd sent SIGKILL. The unit uses `TimeoutStopSec=30s`, `KillSignal=SIGTERM`, and `FinalKillSignal=SIGKILL`. The original shutdown sequence stopped schedulers and BullMQ workers before closing WhatsApp sessions and the control listener.

Read-only process inspection found the control service carrying eight WhatsApp TCP connections and a high CPU sample near 100 percent. Journal evidence showed repeated Baileys group decryption failures such as `No session found to decrypt message`, `Received message with old counter`, and `Expected Buffer instead of: Object`; these are an independent runtime-load issue, not proof that command routing is broken.

The first attempted shutdown hardening used forced BullMQ worker close and shutdown reordering but still took about 30 seconds. The main remaining blocker was identified as `stopWorkloadControlServer()` awaiting `server.close()` while panel long-poll HTTP connections remained open. The control server was changed to track active sockets and destroy them before awaiting `server.close()`. A subsequent restart measured approximately 6.2 seconds, but the process later showed an unrelated non-zero exit during a separate restart event.

The final shutdown change added error-tolerant cleanup sequencing so a closed Telegram transport or any individual cleanup error cannot abort later socket, worker, database, preview, or remote-bridge cleanup. A final restart measured approximately 221 ms for the systemd restart command before normal startup, then the control listener came up and `/workload/health` returned package version 1.2.67. Both control and panel services were active and the panel continued fresh heartbeats. No WhatsApp message or broadcast was sent.

A later journal slice showed the high-volume Baileys decryption failures continuing during the new process. The next investigation should separate their CPU impact from shutdown latency and assess whether the deployed Baileys/node_modules version and malformed encrypted group state require a separate, non-destructive transport maintenance change. Do not purge or re-pair sessions as part of the shutdown audit.

## Final controlled verification

After explicit Redis observers, singleton close hooks, active HTTP socket destruction, safe cleanup sequencing, and the 250 ms bounded exit fence were deployed, a controlled restart measured `restart_ms=488`, with `Result=success`, `ExecMainStatus=0`, and `NRestarts=0`. The control listener and `/workload/health` returned successfully after normal startup, with package version 1.2.67. The panel service remained active. The final lifecycle log showed `transports closed; shutdown complete` at 13:57:03 and the next control process started at 13:57:04; there was no systemd `stop-sigterm` timeout, SIGKILL, or unhandled `Connection is closed` stack in that final restart interval.

The panel recorded expected 502s only while the control listener was intentionally down during the restart, then continued its heartbeat loop. No panel authentication or WhatsApp traffic was touched.
