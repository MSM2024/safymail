# MSM MAIL — P3 final release runbook (Cloudflare Worker preview)

Date: 2026-11-05. Target existing Worker **msm-mail-preview**, custom domain `mailme.msmmystore.com`. Deploy must occur only from the authorized checkout with its existing, private `wrangler.toml` and authenticated Wrangler session. Do not use temporary deployment or automatic project setup, and do not deploy `msm-mail-control-plane` when updating this UI.

## 1. Operator commands: safe gates, then explicit deploy

**Corrección tras prueba del operador (2026-11-05):** este repositorio NO contiene `package-lock.json`, por lo que `npm ci` da `EUSAGE` y no demuestra un fallo de la aplicación. Usa `npm install --no-package-lock` para instalar las versiones permitidas por `package.json` sin crear un lockfile local. Este método es **menos reproducible** que una instalación bloqueada; la tarea futura es incorporar un lockfile versionado y sustituirlo por `npm ci`. No ejecutes deploy si algún gate falla: PowerShell no cancela automáticamente una lista de comandos después de un error de npm.

El registro enviado termina durante la lista de pruebas (en `Spam list includes`); **no consta allí el resultado final del test**, typecheck, validadores, dry-run ni publicación.

Run in `C:\Users\cm8ms\tet\msm-mail`, PowerShell, on `main` after closing the PR. Stop immediately on any nonzero exit status; check `$LASTEXITCODE` after each executable, including Wrangler.

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
npm install --no-package-lock
if ($LASTEXITCODE -ne 0) { throw "Instalación de dependencias fallida" }
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests fallidos" }
npm run typecheck
npm run validate:pwa
npm run validate:security
npm run validate:migrations
npm run qa:p3:deploy:preflight
npx wrangler deploy --config wrangler.toml --dry-run --keep-vars
```

Inspect Wrangler's dry-run binding/asset summary for **msm-mail-preview** (not control plane), intended D1/KV/services and current asset directory. Do not paste token, secret or account IDs in chat. If any binding changed or the preview target is wrong, abort.

Only after all checks are green and the dry run targets the correct Worker:

```powershell
npm run qa:p2:release:prepare
npx wrangler deploy --config wrangler.toml --keep-vars
```

`--keep-vars` preserves dashboard-managed environment variables rather than deleting them when omitted from local config; it does not replace review of bindings and is not a blanket assurance that all deployment settings are preserved. This deployment is a real traffic-affecting change; explicitly authorized by the owner in the current round.

## 2. Post-deploy evidence

Copy **only** the new Worker Version ID printed by Wrangler (UUID format), then:

```powershell
npm run qa:p2:worker:active -- <NEW_WORKER_VERSION_ID>
npm run qa:p2:release:verify
npm run qa:p1:public-deploy
npx wrangler deployments list --config wrangler.toml
```

Also confirm the public `/api/health` response is `ok`, that the login shell and current P3 UI assets load and that private endpoints still return 401 without a session. Before any actual send/receive E2E, use only authorized accounts and approved provider quota. Monitor logs/queues, no blind rollback. Do not equate a successful upload with a healthy release until active-version, routing, auth and UI checks pass.

## 3. Decision / strict boundaries

The release preflight is **read-only** and fails closed on wrong Worker, non-main checkout, stale `origin/main`, dirty tracked worktree or unavailable config. It does not execute Wrangler or use Cloudflare credentials. No Cloudflare management connection is currently available to this chat, so remote deployment must be performed through the operator's configured Wrangler session; neither this runbook nor a merged PR constitutes a live deployment.

The P2 global operational evidence gate remains **BLOCKED** for deferred external metrics and attestation. Its earlier administrative closure does not automatically certify production. Document the deploy SHA, new Worker Version ID, deployment time UTC, active traffic percentage, public health and authentication smoke test before declaring this P3 release accepted.

## 4. Local troubleshooting

- **`wrangler.toml` absent**: recover the already reviewed local configuration; never run plain `wrangler deploy` without targeting the known config.
- **Wrong name or missing D1/KV bindings**: abort without uploading; compare with the last working configuration.
- **Uncommitted changes after `release:prepare`**: expected if `public/msm-release.json` is tracked; do not change source files or switch commits between preparation and deployment.
- **Post-deploy smoke failure**: record observable error and affected version; consider a rollback only against a known-good version with separate operational verification.
