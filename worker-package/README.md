# PAPPY OMEGA-MINI Workload Worker

This package runs only the WhatsApp session workload assigned to it by the central PAPPY OMEGA-MINI control plane. It does not run Telegram, the admin panel, MongoDB, Redis, or any other user's session.

## Requirements

Use Node.js 20 or newer on a compatible Node.js panel. The panel must allow a persistent Node.js process and outbound HTTPS requests.

## Install and start

Upload `index.js`, `package.json`, and this README to the panel, install dependencies, and set these environment variables:

```text
PAPPY_WORKLOAD_URL=https://your-control-domain.example
PAPPY_WORKLOAD_ENROLLMENT_TOKEN=<one-time token from PAPPY OMEGA-MINI>
PAPPY_WORKLOAD_SESSION_SECRET=<private random string of at least 32 characters>
PAPPY_WORKER_DATA_DIR=./pappy-workload-data
```

Then run:

```bash
npm install
node index.js
```

The first successful start prints a five-digit panel key. Add that key in PAPPY OMEGA-MINI under **Workload → Add Panel Key**. The worker stores its authenticated credential and encrypted WhatsApp session files locally in `PAPPY_WORKER_DATA_DIR`.

Never add the Telegram bot token, MongoDB URI, Redis URI, owner secrets, or admin credentials to this worker. Keep the panel data directory persistent across restarts. A stopped panel worker becomes offline but does not delete the session from PAPPY OMEGA-MINI.
