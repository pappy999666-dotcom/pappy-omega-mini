# Hybrid Workload Deployment Status — 2026-08-20

## Main production VPS

The implementation branch `feat/hybrid-workload-saas-20260820` was pushed to GitHub and the compiled build was deployed to `13.50.108.217` using a timestamped rollback copy. Only `pappy-omega-mini` was restarted. After deployment, PM2 reported `pappy-omega-mini` online with PID `459762`; `QUEUE_CONCURRENCY=16` remained intact.

The protected processes were verified unchanged: `omega-core` remained online at PID `177220`, and `omega-test` remained online at PID `216252`. Persistent storage remained present at `/home/ubuntu/pappy-omega-mini-runtime-storage`, and the application storage link still resolves to that directory.

## Workload endpoint safety state

The workload control endpoint is **not activated** in production. `WORKLOAD_CONTROL_ENABLED` and `WORKLOAD_CONTROL_URL` are absent from the application `.env`, so the application default keeps the new control server disabled. Port `8787` is already owned by the pre-existing `omega-core` process; it was not changed or reused by PAPPY OMEGA-MINI.

A real subdomain with TLS must be supplied before enabling the workload server. The Nginx template and environment contract are in `deploy/workload-control.nginx.conf.example` and `docs/HYBRID_WORKLOAD_ARCHITECTURE_20260820.md`.

## Second VPS verification

The inherited snapshot identified a `pappy-omega-mini-worker` process on `167.86.85.193`. Current verification instead found only a stopped PM2 process named `wa-bridge`, whose script belongs to `/root/omega-v1/artifacts/wa-bridge/dist/index.js`, plus the worker package directory `/home/pappy-worker/pappy-omega-mini-worker`. No active `pappy-omega-mini-worker` PM2 process was present. No second-VPS process was started or modified, avoiding interference with the existing Omega deployment. A separate worker restart requires an explicit target process/configuration and a valid control URL.

## Observed log notes

The post-restart log contained existing WhatsApp `Bad MAC` events and missing-auth-file notices for phone-pending sessions. These are transport/session-state conditions visible during startup; no session purge or persistent-storage deletion was performed. They require a separate transport recovery investigation and are not silently treated as successful workload activation.

## Final verification gates

Strict TypeScript compilation passed, all **107/107 tests** passed, the worker runtime passed Node syntax validation, and the official worker archive contained only `index.js`, `package.json`, and `README.md`. The final archive SHA-256 is `71744c9e9ef399cda21e6c489ab38539725a7f3fe0f9a01ca754508abef12469`.
