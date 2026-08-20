# Hybrid Workload Deployment Status — 2026-08-20

## Main production VPS

The implementation branch `feat/hybrid-workload-saas-20260820` was pushed to GitHub and the compiled build was deployed to `13.50.108.217` using a timestamped rollback copy. Only `pappy-omega-mini` was restarted. After deployment, PM2 reported `pappy-omega-mini` online with PID `459762`; `QUEUE_CONCURRENCY=16` remained intact.

The protected processes were verified unchanged: `omega-core` remained online at PID `177220`, and `omega-test` remained online at PID `216252`. Persistent storage remained present at `/home/ubuntu/pappy-omega-mini-runtime-storage`, and the application storage link still resolves to that directory.

## Workload endpoint safety state

The workload control endpoint is now active at `https://pappy-omega-mini.duckdns.org/workload/*`. DNS resolves to `13.50.108.217`. A dedicated Let’s Encrypt certificate was issued for the hostname, and Certbot installed its automatic renewal task. Nginx exposes only `/workload/*` and returns 404 for the root path and other paths.

The application binds privately to `127.0.0.1:8788`. Port `8787` remains owned by the pre-existing `omega-core` process and was not changed or reused by PAPPY OMEGA-MINI. The concrete production vhost is `deploy/pappy-omega-mini.duckdns.org.nginx`; the reusable template is `deploy/workload-control.nginx.conf.example`.

## Panel-style smoke test

The official restricted `index.js` was run from an isolated temporary panel directory against the live HTTPS endpoint with a real one-time owner enrollment token. It registered successfully, printed display key `01253`, and the central registry recorded the worker as `ACTIVE` with worker version `1.0.0` and a fresh heartbeat. The temporary worker was then revoked cleanly; no session was assigned and no persistent user data was changed.

The tester-ready archive is `/home/ubuntu/pappy-omega-mini-worker-tester-v1.0.0.tar.gz` with SHA-256 `44d22e2bfd107caa2f990bb7e6a3aade4e4e9178c1bbca9f7480d3b9e41e7caa`.

## Second VPS verification

The inherited snapshot identified a `pappy-omega-mini-worker` process on `167.86.85.193`. Current verification instead found only a stopped PM2 process named `wa-bridge`, whose script belongs to `/root/omega-v1/artifacts/wa-bridge/dist/index.js`, plus the worker package directory `/home/pappy-worker/pappy-omega-mini-worker`. No active `pappy-omega-mini-worker` PM2 process was present. No second-VPS process was started or modified, avoiding interference with the existing Omega deployment. A separate worker restart requires an explicit target process/configuration and a valid control URL.

## Observed log notes

The post-restart log contained existing WhatsApp `Bad MAC` events and missing-auth-file notices for phone-pending sessions. These are transport/session-state conditions visible during startup; no session purge or persistent-storage deletion was performed. They require a separate transport recovery investigation and are not silently treated as successful workload activation.

## Final verification gates

Strict TypeScript compilation passed, all **107/107 tests** passed, the worker runtime passed Node syntax validation, and the official worker archive contained only `index.js`, `package.json`, and `README.md`. The final archive SHA-256 is `71744c9e9ef399cda21e6c489ab38539725a7f3fe0f9a01ca754508abef12469`.
