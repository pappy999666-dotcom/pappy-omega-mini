# PAPPY OMEGA-MINI Workload Worker

This small package runs only the WhatsApp session workload assigned to it by the central PAPPY OMEGA-MINI control plane. It does not contain Telegram, MongoDB, Redis, admin credentials, or another user’s data.

## What the user needs

The user needs Node.js 20 or newer, a panel that can keep a Node.js process running, and outbound HTTPS access. The user does not need to create a secret, configure MongoDB, configure Redis, or add a Telegram token.

## One-command setup

In PAPPY OMEGA-MINI, open **Workload → Create Panel Code** and copy the setup command. Download this package, open its folder, and paste the copied command into the panel terminal:

```bash
npm install --omit=dev && node index.js --enrollment PASTE_THE_ONE_TIME_TOKEN_HERE
```

The command uses the official HTTPS control endpoint by default. On the first start, the worker asks:

```text
Choose a name for this workload (example: pappy):
```

Enter a short name such as `pappy`, `business`, or `tester-1`. The worker creates and stores its own local secret, registers securely, and prints a permanent code similar to:

```text
pappy-AB12CD
```

Keep that code safe. Return to Telegram and open **Workload → Add My Workload Code**, then paste the code. The code is workspace-scoped and cannot be reused or attached to another workspace. It remains reserved even if the worker is later disconnected or revoked.

When the user taps **Pair Number**, PAPPY OMEGA-MINI shows the user’s ACTIVE workloads. Selecting `pappy-AB12CD` makes the next WhatsApp pairing run on that worker. Existing sessions are not moved automatically.

## Persistent storage

Keep the `pappy-workload-data` directory persistent across restarts. It contains the encrypted worker credential and the encrypted WhatsApp session files. If the directory is deleted, the panel must be enrolled again and the worker will not retain its local WhatsApp sessions.

## Optional environment overrides

The copied command is enough. Advanced operators may override these values:

```text
PAPPY_WORKLOAD_URL=https://pappy-omega-mini.duckdns.org
PAPPY_WORKLOAD_NAME=pappy
PAPPY_WORKLOAD_ENROLLMENT_TOKEN=<one-time token>
PAPPY_WORKER_DATA_DIR=./pappy-workload-data
PAPPY_WORKLOAD_SESSION_SECRET=<optional private 32+ character value>
PAPPY_WORKER_VERSION=1.0.0
```

If `PAPPY_WORKLOAD_SESSION_SECRET` is omitted, the worker generates a private local secret automatically. Never add the Telegram bot token, MongoDB URI, Redis URI, owner secrets, or admin credentials to this package.
