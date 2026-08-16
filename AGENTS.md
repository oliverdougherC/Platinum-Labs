# Agent operating guide — Platinum Labs Homelab Homepage

Standing operational instructions for coding agents (Claude, Codex, Fable, …)
working in this repository. Read this before touching production.

## The one workflow that matters

When a change is explicitly intended to go live on the Homelab Homepage, the
job is NOT done at "code is committed". The end-to-end workflow is:

1. `npm run verify` (typecheck + lint + tests + production build)
2. commit intentionally (never `git add -A` blindly)
3. push (production only ever runs pushed code)
4. deploy the exact pushed ref/SHA: `npm run deploy -- <ref-or-sha>`
   (default ref is `finish-v1`, the current production branch)
5. confirm `/api/health` on the server reports `status: ok` and the expected
   `revision` SHA — the deploy script does this, but never claim success
   without the running service having been checked
6. smoke-test the functionality your change affects, through the deployed
   dashboard (not by calling backing services directly)

Deployment is never implicit: code merely changing does not mean it should be
deployed. Deploy when the task actually intends the change to go live.

## Production topology (do not reinvent)

- Server: `ofhd@100.99.6.59` (Tailscale, host `p910`)
- Stack dir: `/mnt/NVME/docker/compose/platinum-homepage/`
  - `compose.yaml` — server-owned Compose file (Dockge convention). This is
    the deployed topology; the repo's `docker-compose*.yml` are the reference
    architecture for it.
  - `.env` — server-owned runtime secrets (mode 600). Authoritative. Never
    commit, print, copy, or overwrite it.
  - `src/` — git checkout of this repo; the deploy script fast-forwards it to
    the exact requested SHA (detached HEAD) and rebuilds.
  - `backups/<sha>-<timestamp>/` — pre-deploy SQLite backups.
- The dashboard reaches media services by Docker DNS on their existing
  external networks (`media_pipeline_default`, `jellyfin_default`) because the
  host firewall blocks container→host traffic. Never delete or recreate those
  networks; this stack does not own them.
- Dashboard is published on port `30190`; SQLite persists in the
  `platinum-homepage_data` named volume.

## Hard rules

- Never deploy uncommitted or unpushed code; the deploy script refuses local
  modifications on the server checkout — do not "fix" that by editing files on
  the server.
- Never delete the persistent DB volume; never `docker compose down -v`.
- Always back up before deployment (the deploy script does this and fails
  loudly if it cannot).
- Never expose `SEERR_API_KEY` or any other `.env` secret in code, logs,
  client responses, git, or chat output.
- Radarr/Sonarr `/api/v3/queue?movieId=…`/`?seriesId=…` filtering is silently
  ignored by the server. Before ANY queue deletion: fetch the full queue,
  filter client-side on the exact id, inspect the matched records. Never
  bulk-delete; never use `removeFromClient=true` casually.
- Rollback = `npm run deploy -- <previous-sha>` (the previous SHA is printed
  by every deploy and encoded in the backup dir name). Restore the DB backup
  only if schema compatibility requires it — see docs/DEPLOYMENT.md.

## Where things are

- Deploy script: `scripts/deploy-production.sh` (`npm run deploy -- <ref>`)
- Push + deploy helper: `scripts/push-and-deploy.sh` (clean tree required)
- Full deployment/rollback/backup reference: `docs/DEPLOYMENT.md`
- Verification suite: `npm run verify`

## Visual changes require visible screenshot evidence

Major visual/UI changes are NOT review-ready until the pull request itself
shows the result. This is a hard gate, equal in standing to tests:

- Regenerate the deterministic review screenshots with
  `npm run screenshots` (and `npm run screenshots:motion` for animation
  changes). The harness uses the fake simulator with a frozen clock
  (`?scenario=…&freeze=<epoch-ms>` plus `panel=`/`drawer=` params), so the
  same commit produces the same frames.
- Commit the PNGs (and motion webm/gif) under `docs/review/<change-name>/`
  in a dedicated review-artifact commit, and embed them in the PR body with
  raw URLs pinned to that commit SHA. Never point reviewers at local paths
  or buried CI artifacts.
- Include at least one before/after comparison for redesigns, and one
  screenshot backed by validated real server data when data semantics
  changed.
- Review-artifact files may be removed in a cleanup commit AFTER visual
  approval; the PR body keeps the commit-pinned links.

## Project state

- Production branch (current): `finish-v1`. Do not merge it into `main`
  without explicit instruction. The deploy tooling takes any ref, so the
  canonical ref can move to `main` later without script changes.
- Track work in Linear (PLA-…). After a production deploy, update the relevant
  issue with the deployed SHA and verification result — truthfully.
