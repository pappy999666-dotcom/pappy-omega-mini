# PAPPY OMEGA-MINI Workload Worker

This distribution is intentionally **one file**. It contains only `index.js`, which creates the small private `package.json`, installs the restricted WhatsApp dependencies, creates local encrypted worker storage, and starts the panel runtime.

The user does not need to create an `.env` file, write a `package.json`, configure MongoDB, configure Redis, add a Telegram token, or create a session secret.

## Setup

In Telegram, open **PAPPY OMEGA-MINI → Workload → Create Panel Code** and copy the one-time enrollment token or setup command. Upload `index.js` to a Node.js 20+ panel, open the terminal in that folder, and run:

```bash
node index.js --enrollment ONE_TIME_TOKEN
```

The first run has four visible stages. The panel prints a progress line for every stage, and a long installation step prints a heartbeat every five seconds so nobody mistakes it for a freeze. Any npm output before the green readiness message belongs to installation; do not type a panel name while that stage is running. A normal first start looks like this:

```text
[PAPPY PANEL] Boot sequence started · Node.js v22.x
[STAGE 1/4] Reading panel folder and preparing private worker files…
[STAGE 2/4] Required WhatsApp dependencies are not ready.
[PROCESSING] Installing Baileys 2.7.12 and the Pino logger · started · please do not type yet
[PROCESSING] Installing Baileys 2.7.12 and the Pino logger · still working · 5s elapsed · panel is not frozen
[PROCESSING] Installing Baileys 2.7.12 and the Pino logger · still working · 10s elapsed · panel is not frozen
[OK] Dependencies installed successfully.
[STAGE 3/4] Verifying the installed runtime before asking questions…
[OK] Runtime verification passed.
[STAGE 4/4] Launching the interactive PAPPY setup now…
```

If dependencies are already present, the panel says `[STAGE 2/4] Dependencies already installed · skipping npm install.` and moves on. Only after Stage 4 will it ask:

```text
[PAPPY SETUP · STEP 1/2] Choose a short name for this panel.
Use letters or numbers, for example: pappy, jesus, business-panel.
› Panel name:
```

Enter a simple name such as `pappy`, `jesus`, or `business-panel`. Do not enter only `.`, punctuation, or a blank value. The worker registers securely and prints a permanent workload code such as:

```text
pappy-ab12cd
```

Keep that code safe. In Telegram, open **Workload → Add My Workload Code** and paste it. Wait for the panel to show `ACTIVE` and a fresh heartbeat. Then open **My Workloads**, select the panel, tap **Use This Workload**, and tap **Pair Number**. Telegram will use the selected workload for the new WhatsApp session.

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

`ACTIVE` means the worker is registered and sending heartbeats. `DEGRADED` means the worker has reported a recoverable transport or control error; the matrix now prints a readable wrapped detail and a beginner-facing next step. Dependency installation and the interactive question are intentionally separated so a name cannot be typed into an unfinished npm process. The logger uses clean ANSI cyber-console colors when the panel supports color and automatically falls back to readable plain text when it does not. The matrix never prints enrollment tokens, worker credentials, Telegram tokens, MongoDB URLs, Redis URLs, message payloads, or another user’s data.

## If setup stops with `fatal startup error`

Do not type a panel name into an npm installation screen. Wait for `[OK] Dependencies installed successfully.`, `[OK] Runtime verification passed.`, and `[STAGE 4/4] Launching the interactive PAPPY setup now…`. The yellow `[PROCESSING] … still working … Ns elapsed` line means the panel is actively installing and is not frozen. If the worker says that an enrollment token is missing or expired, return to Telegram, create a new one-time setup command, copy the complete command beginning with `node index.js --enrollment`, and run it again in the panel folder. If the name is rejected, answer with letters, numbers, or hyphens such as `pappy` and never use only `.`.
