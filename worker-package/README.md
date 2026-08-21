# PAPPY OMEGA-MINI Workload Worker

This distribution is intentionally **one file**. It contains only `index.js`, which creates the small private `package.json`, installs the restricted WhatsApp dependencies, creates local encrypted worker storage, and starts the panel runtime.

The user does not need to create an `.env` file, write a `package.json`, configure MongoDB, configure Redis, add a Telegram token, or create a session secret.

## Setup

In Telegram, open **PAPPY OMEGA-MINI → Workload → Create Panel Code** and copy the one-time enrollment token or setup command. Upload `index.js` to a Node.js 20+ panel, open the terminal in that folder, and run:

```bash
node index.js --enrollment ONE_TIME_TOKEN
```

The first run creates `package.json`, installs only `@crysnovax/baileys` 2.7.12 and `pino`, then asks for a friendly name:

```text
Choose a name for this workload (example: pappy):
```

Enter `pappy`, `business`, or another short name. The worker registers securely and prints a permanent workload code such as:

```text
pappy-ab12cd
```

Keep that code safe. In Telegram, open **Workload → Add My Workload Code** and paste it. When the user taps **Pair Number**, Telegram shows the user’s ACTIVE workloads. Selecting `pappy-ab12cd` makes the next WhatsApp pairing run on that panel.

## Restarting the panel

Run the same command again or use the panel’s normal start command. The generated `package.json`, `node_modules`, and `pappy-workload-data` directory remain on the panel, so dependencies are not installed again and the worker credential/session state is reused. The one-time enrollment token is only needed on the first registration.

Keep `pappy-workload-data` persistent. It contains the encrypted worker credential and WhatsApp session files. Do not delete it unless you intentionally want to enroll a new worker.

The workload code is workspace-scoped, permanently reserved, and cannot be reused for another workspace. Revoking a worker does not delete central user sessions or accounts.

## Signed automatic updates

The worker checks the control plane shortly after startup and periodically thereafter. A release is accepted only when its SHA-256 hash and Ed25519 signature verify against the public key embedded in this file’s release build. The worker writes the new `index.js` atomically, flushes encrypted session state, and restarts through the panel’s existing process supervisor. WhatsApp auth files, the worker credential, and assignment state remain in `pappy-workload-data`.

Updates are disabled with `PAPPY_WORKLOAD_AUTO_UPDATE=false` when a panel operator needs a maintenance freeze. No MongoDB URI, Redis URI, Telegram token, enrollment token, or release private key is delivered to the panel.

The downloadable `index.js` is generated in a minified/mangled release form so it can be further protected by the panel operator’s approved obfuscation pipeline. The third-party Baileys dependency itself is not modified or repackaged; its license and attribution requirements remain unchanged.

Never add Telegram, MongoDB, Redis, owner, or admin credentials to this file or panel directory.

## Matrix logger

The worker prints a compact ASCII matrix instead of a raw or garbled event stream. It contains only safe operational fields:

```text
+---------------- PAPPY WORKLOAD MATRIX ----------------+
| NAME       | pappy                                     |
| CODE       | pappy-ab12cd                              |
| STATE      | ACTIVE                                    |
| SESSIONS   | 0                                         |
| HEARTBEAT  | 3s                                        |
| CONTROL    | 1s                                        |
| ACTION     | heartbeat; 0 assigned                    |
| ERROR      | none                                      |
+--------------------------------------------------------+
```

`ACTIVE` means the worker is registered and sending heartbeats. `DEGRADED` means the worker has reported a recoverable transport or control error; the last safe error is shown in the matrix. The matrix never prints enrollment tokens, worker credentials, Telegram tokens, MongoDB URLs, Redis URLs, message payloads, or another user’s data.
