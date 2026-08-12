# Deployment, update, rollback & backup

The Homelab Homepage is a **long-running Node server** (in-process poll scheduler,
aggregate loop, and hourly SQLite maintenance) — not a stateless/serverless app.
It ships as a hardened multi-stage image and a Compose stack.

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Network topology](#network-topology)
- [ZFS collector](#zfs-collector)
- [Update / rollback / backup](#update--rollback--backup)
- [Health endpoint](#health-endpoint)
- [Security & trust model](#security--trust-model)
- [24-hour soak](#24-hour-soak)

## Quick start

```bash
cp .env.example .env      # fill in connector URLs/keys (blank = fake mode)
docker compose up -d --build
```

The container:
- runs as a non-root user (uid 1001),
- drops all capabilities (`cap_drop: ALL`, `no-new-privileges`),
- persists SQLite to the `homelab-data` volume at `/data/homelab.db`,
- exposes `:3000` (published to `127.0.0.1:3000` by default),
- has a working healthcheck (`/api/health`),
- carries no Docker socket, no host mounts, no privileged mode.

## Configuration

All configuration is environment-driven; see [`.env.example`](../.env.example) for
the full, commented list. Key points:

- `HOMELAB_DATA_MODE=live` turns on the real connectors; `fake` runs the
  deterministic simulator (no network, no secrets needed).
- Each connector is validated **as a set** — a URL without its key (or a qB URL
  without credentials) is reported as a *misconfiguration*, not silently ignored.
- Missing/disabled connectors do not error; they render as "not configured".
- **Backend connector URLs** are how the *server* reaches your services. Prefer
  in-cluster addresses (Docker DNS, see below).
- **`HOMELAB_QUICK_LINKS`** are the launch tiles your *browser* opens — they must
  be reachable from the client, and are deliberately separate from the backend
  URLs (the dashboard may be viewed from a laptop while services run elsewhere).
- Never commit `.env`. On the server, keep it `chmod 600`.

## Network topology

The server reaches your services one of two ways:

1. **Docker DNS on the services' networks (recommended for co-located stacks).**
   Declare the existing service networks as `external` and join them, then use
   container names:
   ```yaml
   services:
     dashboard:
       networks: [internal, media_stack_default, jellyfin_default]
       # env: SONARR_URL=http://sonarr:8989, JELLYFIN_URL=http://jellyfin:8096, ...
   networks:
     media_stack_default: { external: true }
     jellyfin_default:     { external: true }
   ```
   This stack **never owns or deletes** those networks (they are `external`); it
   only attaches to them, so there is no lifecycle coupling and no new host ports.
   Use this when the host firewall blocks container→host traffic (common), which
   makes `host.docker.internal`/host-IP unreachable.

2. **`host.docker.internal` + already-published ports** (when container→host is
   allowed). Add `extra_hosts: ["host.docker.internal:host-gateway"]` and point
   backends at `http://host.docker.internal:<published-port>`.

qBittorrent behind a VPN sidecar (e.g. gluetun) publishes its WebUI on the VPN
container — reach it at `http://<vpn-container>:<webui-port>` on the shared
network. The client supports both qB < 5 (`Ok.`) and qB 5.x (HTTP 204 +
`QBT_SID_<port>` cookie).

## ZFS collector

Reading ZFS needs `zpool` + `/dev/zfs` on the host. The dashboard container must
**not** get that access. Two supported, compartmentalized options:

- **Host-side helper** (`scripts/zfs-collector.mjs` Node, or
  `scripts/zfs-collector.py` Python): a tiny read-only service exposing normalized
  pool JSON behind a bearer token. Run it where the dashboard can reach it and set
  `ZFS_COLLECTOR_URL` / `ZFS_COLLECTOR_TOKEN`. Fixed `zpool` argv, no shell, no
  write endpoint. If your host lets non-root read `zpool`, run it unprivileged.

- **Sidecar container** (`docker/zfs-collector.Dockerfile`): the same collector
  as a single-purpose container on the dashboard's **private** network, reading
  ZFS via `--device=/dev/zfs`. Verified to work read-only with `cap_drop: ALL`,
  `read_only: true`, `no-new-privileges`, no host mounts, no socket, no privileged
  mode. Use this when the host firewall blocks container→host (so a host-side
  helper would be unreachable) but `/dev/zfs` is accessible:
  ```yaml
  zfs-collector:
    build: { context: ., dockerfile: docker/zfs-collector.Dockerfile }
    environment: { ZFS_COLLECTOR_TOKEN: "${ZFS_COLLECTOR_TOKEN}" }
    devices: ["/dev/zfs:/dev/zfs"]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    networks: [internal]     # never publish to the LAN
  # dashboard env: ZFS_COLLECTOR_URL=http://zfs-collector:9797
  ```

Direct command mode (`HOMELAB_ZFS_COMMAND=1`) is only for a bare-metal/native
deploy running **on** the ZFS host — never grant the containerized dashboard
`/dev/zfs`.

## Update / rollback / backup

**Update** to a new release candidate (history is preserved on the volume):
```bash
git -C <src> fetch && git -C <src> checkout <ref>     # or re-sync the source
docker compose build && docker compose up -d
```

**Rollback** — the stack is isolated (own containers + own volume; external
networks are untouched):
```bash
docker compose down            # stop/remove THIS stack only; volume kept
# rebuild the previous commit, then: docker compose up -d
```
Because migrations are append-only and idempotent, a restart/downgrade preserves
existing history.

**Backup** the small local DB (checkpoint the WAL first for a clean copy):
```bash
docker exec platinum-homepage node -e "const D=require('better-sqlite3');const db=new D(process.env.HOMELAB_DB_PATH);db.pragma('wal_checkpoint(TRUNCATE)');db.close()"
docker run --rm -v <project>_homelab-data:/data -v "$PWD":/backup alpine \
  sh -c "cp /data/homelab.db /backup/homelab-$(date +%F).db"
```
Restore by copying the file back into the volume while the stack is stopped.

## Health endpoint

`GET /api/health` returns `{ status: "ok", mode, uptimeSeconds }` with HTTP 200
whenever the process can serve requests. It **does not** fail on connector
outages (those are reported per-connector in `/api/dashboard`), so it is safe for
container/reverse-proxy liveness. `GET /api/dashboard` returns the full normalized
snapshot (always 200 with partial data — a down connector never blanks the page).

## Security & trust model

- All service credentials are server-side only, loaded from env/secret files;
  none reach the browser. The `/api/dashboard` payload is normalized and carries
  no API keys, qB password, ZFS token, raw infohashes, tracker URLs, peer IPs, or
  filesystem paths (verified by test and by a live payload audit).
- Connector errors are sanitized (status codes only) before logging or surfacing.
- No third-party analytics/telemetry; no remote fonts/assets.
- The app has **no built-in authentication**. Keep it on a private/LAN/Tailscale
  network. If you expose it, put it behind a reverse proxy (e.g. Nginx Proxy
  Manager) that terminates TLS and enforces access control.
- The ZFS collector is read-only, token-authenticated, fixed-argv, and never
  published to the LAN.

## 24-hour soak

The continuous-display soak (PLA-197) is run with the committed harness:
```bash
npm run soak            # see docs/SOAK.md for options and what it records
```
Point it at the deployed dashboard and leave it running ≥24h on the secondary
display. It records CPU/RSS and DB growth over time and checks for polling
overlap, memory creep, and animation/DOM accumulation. See
[`docs/SOAK.md`](./SOAK.md).
