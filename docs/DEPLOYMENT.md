# Deployment, update, rollback & backup

The Homelab Homepage is a **long-running Node server** (in-process poll scheduler,
aggregate loop, and hourly SQLite maintenance) rather than a stateless/serverless
app. It ships as a hardened multi-stage image, a base Compose file, and a
production override that keeps the app on private networks by default.

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Network topology](#network-topology)
- [ZFS collector](#zfs-collector)
- [Routine redeploy (the normal path)](#routine-redeploy-the-normal-path)
- [Update / rollback / backup (manual reference)](#update--rollback--backup-manual-reference)
- [Health endpoint](#health-endpoint)
- [Security & trust model](#security--trust-model)
- [24-hour soak](#24-hour-soak)

## Quick start

```bash
cp .env.example .env
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d --build
```

If this host needs the private ZFS sidecar, enable the profile explicitly:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  --profile zfs-sidecar \
  up -d --build
```

The production stack:
- runs as a non-root user (`uid 1001`),
- persists SQLite to the `homelab-data` named volume at `/data/homelab.db`,
- binds `:3000` to `127.0.0.1` by default (`HOMEPAGE_BIND_ADDRESS` / `HOMEPAGE_PORT`),
- keeps the app filesystem read-only except for `/data` and tmpfs-backed `/tmp`,
- drops all capabilities (`cap_drop: ALL`, `no-new-privileges`),
- keeps logs bounded (`10m x 3`),
- joins your existing media/Jellyfin Docker networks without owning them,
- never publishes the ZFS sidecar to the LAN.

## Configuration

All configuration is environment-driven; see [`.env.example`](../.env.example) for
the full, commented list. Key points:

- `HOMELAB_DATA_MODE=live` turns on the real connectors; `fake` keeps the app fully
  usable without network access or secrets.
- Each connector is validated **as a set**. A URL without its key (or a qB URL
  without credentials) is an explicit misconfiguration, not a silent fallback.
- `HOMEPAGE_BIND_ADDRESS`, `HOMEPAGE_PORT`, and `HOMEPAGE_VOLUME_NAME` control the
  production override's bind target and persistent volume name.
- `MEDIA_NETWORK_NAME` and `JELLYFIN_NETWORK_NAME` point at **existing external**
  Docker networks that already contain Sonarr/Radarr/qBittorrent/Jellyfin.
- `HOMELAB_QUICK_LINKS` are browser-facing launch tiles and intentionally separate
  from the backend connector URLs the server uses.
- Never commit `.env`. On the deployment host, keep it `chmod 600`.

### Seerr / Jellyseerr media requests (optional)

```env
SEERR_URL=http://jellyseerr:5055     # Docker DNS on the media network, like the other connectors
SEERR_API_KEY=<Settings → General → API Key>
SEERR_REQUESTS_ENABLED=1             # 0 = search stays available, requests are disabled
```

- The API key is **administrator-level for Seerr** (it can approve requests).
  It never leaves the server — not in dashboard state, browser responses,
  errors, or logs — but rotate it from Seerr's Settings → General if the `.env`
  is ever exposed, and keep the file `chmod 600`.
- **Approval guarantee**: every dashboard-created request must reach `APPROVED`
  before the UI reports success. If Seerr returns the new request as pending,
  the backend explicitly calls `POST /api/v1/request/{id}/approve` and verifies
  the result; an unconfirmable approval is surfaced as a failure, never as a
  silently pending request.
- **Downstream behavior is yours**: whether an approved request triggers an
  automatic Radarr/Sonarr search or download is controlled by your existing
  Seerr/Radarr/Sonarr settings. The dashboard does not require, force, or check
  `Enable Automatic Search`, and it reports success at `Approved`, not
  `Downloading`.
- Migrating from Jellyseerr to Seerr v3: the legacy `JELLYSEERR_URL` /
  `JELLYSEERR_API_KEY` names are accepted as per-field aliases and `SEERR_*`
  wins when both are set. The integration targets the Seerr v3 `/api/v1`
  contract (Jellyseerr ≥ 2.x is compatible); smoke-test search + one request
  after upgrading either side.
- Poster artwork is proxied through the dashboard origin (`/api/seerr/poster`),
  which only fetches validated TMDB poster paths — the browser makes no
  third-party requests and no extra metadata API key is needed.

## Network topology

The production override is designed for **Docker DNS first**. Set the connector
URLs to service names on the external networks your media stacks already own:

```env
SONARR_URL=http://sonarr:8989
RADARR_URL=http://radarr:7878
QBITTORRENT_URL=http://gluetun:8080
JELLYFIN_URL=http://jellyfin:8096
MEDIA_NETWORK_NAME=media_default
JELLYFIN_NETWORK_NAME=jellyfin_default
```

`docker-compose.production.yml` declares those networks as `external`, so this
stack **attaches** to them but never creates, deletes, or renames them. That
keeps the dashboard isolated from the lifecycle of the service stacks it reads.

If your environment already publishes services on the host and container-to-host
traffic is allowed, `host.docker.internal` still works because the base Compose
file includes `extra_hosts: host.docker.internal:host-gateway`. Docker DNS is
still preferred because it avoids host-port coupling.

## ZFS collector

Reading ZFS requires `zpool` plus `/dev/zfs` on the host. The dashboard container
must **not** get that access. Two supported modes:

1. **Host-side helper** (`scripts/zfs-collector.mjs` or `scripts/zfs-collector.py`).
   Run the tiny token-authenticated collector on the ZFS host and point the app
   at it with `ZFS_COLLECTOR_URL` / `ZFS_COLLECTOR_TOKEN`. This is the default
   choice when the dashboard can reach the host helper.
2. **Private sidecar profile** (`docker-compose.production.yml`, profile
   `zfs-sidecar`). This is the same read-only collector in a single-purpose
   container that gets `/dev/zfs` and nothing else:

   ```bash
   ZFS_COLLECTOR_URL=http://zfs-collector:9797
   docker compose \
     -f docker-compose.yml \
     -f docker-compose.production.yml \
     --profile zfs-sidecar \
     up -d --build
   ```

   The sidecar:
   - is only on the internal `zfs_private` network,
   - exposes `9797` to sibling containers only (`expose`, no published port),
   - keeps a read-only filesystem with a small tmpfs-backed `/tmp`,
   - drops all capabilities and sets `no-new-privileges`,
   - receives `/dev/zfs` **only** in that sidecar, never in `homepage`,
   - authenticates every request with `ZFS_COLLECTOR_TOKEN`,
   - advertises a stable private DNS name: `zfs-collector`.

Direct command mode (`HOMELAB_ZFS_COMMAND=1`) is only for a bare-metal/native
deploy running **on** the ZFS host. Do not combine it with the containerized
dashboard.

### Current p910 Living Topology prerequisites

The final PLA-263 read-only production audit established these non-secret
values for the server-owned `.env` at the next intentional deployment:

```env
HOMELAB_DOWNLOAD_POOL=DataStore
HOMELAB_MEDIA_POOL=DataStore
HOST_NET_INTERFACES=ens6f1
```

qBittorrent's active default save path is `/data/downloads/complete`, and its
`/data` mount is backed by `/mnt/DataStore/data`; Jellyfin's `/data/media`
library mount is backed by the same ZFS pool. Imports are therefore same-pool
organizing on this host, not a measured cross-pool copy. `ens6f1` is the only
active physical/default-route interface; selecting it excludes Tailscale and
Docker virtual-interface counters from gateway throughput.

These variables were unset or empty when audited. This document does not
authorize editing the production `.env`; apply them only as part of a separate,
intentional deployment/configuration change.

## Routine redeploy (the normal path)

Day-to-day deployments go through the canonical deploy script — everything
below this section is the manual/emergency reference, not the routine path.

```bash
npm run deploy                    # deploy the tip of finish-v1 (current production ref)
npm run deploy -- <branch|tag>    # deploy another pushed ref
npm run deploy -- <full-40-sha>   # deploy/roll back to an exact commit
```

Or, after an intentional commit on the production branch:

```bash
./scripts/push-and-deploy.sh      # requires clean tree; pushes, then deploys that exact SHA
```

The script ([scripts/deploy-production.sh](../scripts/deploy-production.sh))
resolves the ref on the GitHub remote, refuses local modifications on the
server checkout, backs up the SQLite DB (WAL checkpoint + `/data` copy,
labelled `backups/<prev-sha>-<stamp>/`), checks out the exact SHA, rebuilds
through the server's existing Compose stack, waits for `/api/health`, smoke
checks `/` and `/api/dashboard`, and prints the previous SHA / new SHA /
backup path. Any failure exits non-zero. `/api/health` reports the deployed
SHA as `revision`.

**Rollback** is the same command with the previous SHA (printed by every
deploy):

```bash
npm run deploy -- <previous-sha>
```

Restore the DB backup only when required by schema compatibility — see
[Schema-aware rollback](#schema-aware-rollback).

### Server layout (current production host)

`ofhd@100.99.6.59`, stack at `/mnt/NVME/docker/compose/platinum-homepage/`:
a server-owned `compose.yaml` (Dockge convention) + server-owned `.env`
(authoritative, mode 600) + `src/` (git checkout of this repo, build context)
+ `backups/`. One-time bootstrap for a new host of this shape:

```bash
cd <stack-dir>
git clone https://github.com/oliverdougherC/Platinum-Labs.git src
# author compose.yaml + .env, then run the deploy script from a dev machine
```

Override targets per invocation with `DEPLOY_HOST`, `DEPLOY_DIR`,
`DEPLOY_REF`, `DEPLOY_PORT` (see the script header).

## Update / rollback / backup (manual reference)

Use the production override for every lifecycle command so the same topology,
volume name, and profile wiring are preserved:

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.production.yml"
```

### Backup first

Before every update or rollback rehearsal, force a WAL checkpoint and capture a
release-labelled backup plus the current schema metadata:

```bash
RELEASE=v0.1.0
STAMP=$(date +%Y%m%dT%H%M%S)
BACKUP_DIR="$PWD/backups/${RELEASE}-${STAMP}"
mkdir -p "$BACKUP_DIR"

$COMPOSE exec -T homepage node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.HOMELAB_DB_PATH);
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)");
  const migrations = db.prepare("SELECT id, name, applied_at FROM schema_migrations ORDER BY id").all();
  console.log(JSON.stringify({ dbPath: process.env.HOMELAB_DB_PATH, checkpoint, migrations }, null, 2));
  db.close();
' | tee "$BACKUP_DIR/schema.json"

$COMPOSE cp homepage:/data/. "$BACKUP_DIR/data"
```

That backup is tied to the release label in the directory name and contains the
actual database plus any companion files left after the checkpoint.

### Update

```bash
git -C <src> fetch
git -C <src> checkout <ref>
$COMPOSE up -d --build
```

Migrations are append-only and idempotent, so normal forward updates preserve the
existing history volume.

### Schema-aware rollback

1. Check out the target release in source control.
2. Compare the migration IDs in `backups/<release>-<stamp>/schema.json` with the
   target release's [`src/lib/db/schema.ts`](../src/lib/db/schema.ts).
3. If the target release still knows every applied migration ID, an image-only
   rollback is safe:

   ```bash
   $COMPOSE down
   $COMPOSE up -d --build
   ```

4. If the target release predates **any** migration ID found in `schema.json`,
   restore the matching DB backup before booting that older image.

### Restore

Restore into the service volume while the stack is stopped. This flow addresses
the Compose service and derives the actual volume name at runtime instead of
assuming a hardcoded container name:

```bash
$COMPOSE down
$COMPOSE create homepage
DATA_VOLUME=$(docker inspect "$($COMPOSE ps -q homepage)" \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')

docker run --rm \
  -v "${DATA_VOLUME}:/data" \
  -v "${BACKUP_DIR}/data:/backup:ro" \
  alpine sh -c '
    test -f /backup/homelab.db
    stamp=$(date +%Y%m%dT%H%M%S)
    for file in /data/homelab.db /data/homelab.db-wal /data/homelab.db-shm; do
      test ! -e "$file" || mv "$file" "$file.pre-restore-$stamp"
    done
    cp /backup/homelab.db /data/homelab.db
  '

$COMPOSE rm -f homepage
$COMPOSE up -d
```

Keep the backup that matches each deployed release. If an older image cannot read
the newer schema, restoring the older release's backup is the correct rollback,
not forcing the new DB into the old binary.

## Health endpoint

`GET /api/health` returns `{ status: "ok", mode, uptimeSeconds }` with HTTP 200
whenever the process can serve requests. It **does not** fail on connector
outages, so it is safe for container and reverse-proxy liveness checks. Full
connector health remains in `/api/dashboard`.

## Security & trust model

- All service credentials are server-side only. The normalized dashboard payload
  carries no API keys, qB password, ZFS token, raw infohashes, tracker URLs,
  peer IPs, or filesystem paths.
- Connector errors are sanitized before they are logged or returned.
- No third-party analytics, telemetry, or remote fonts are used.
- The app has **no built-in authentication**. Keep it on a private/LAN/Tailscale
  network, or front it with a reverse proxy that terminates TLS and enforces
  access control.
- The ZFS sidecar is read-only, internal-only, token-authenticated, and never
  published on the LAN.

## 24-hour soak

PLA-197 requires a **literal 24-hour run** against the deployed stack. Use the
committed harness so the measurements come from the real Compose service and real
SQLite volume:

```bash
npm run soak -- \
  --url http://127.0.0.1:3000 \
  --duration 86400 \
  --interval 7 \
  --sample 60 \
  --compose-file docker-compose.yml \
  --compose-file docker-compose.production.yml \
  --compose-service homepage \
  --out soak-report.ndjson
```

The harness records container RSS, request failures, DB byte size, row counts for
`throughput_samples` / `storage_samples` / `activity_events`, and SQLite
`page_count` / `freelist_count`. Review the procedure and pass criteria in
[`docs/SOAK.md`](./SOAK.md).
