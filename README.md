# Homelab Homepage

A living topology for homelab operations: quiet at rest, explicit about missing
evidence, and useful at a glance on a secondary monitor.

The scene models the host, network gateway, Docker containers, media/acquisition
pipeline (Jellyfin + Sonarr + Radarr + qBittorrent), and ZFS pools. Activity
flows appear only when telemetry supports them, while the metric rail and
drawers preserve exact values, provenance, freshness, and uncertainty.

This repository tracks the Linear project **Homelab Homepage** (team `PLA`);
Linear is the source of truth for scope and acceptance criteria.

## Tech stack

- **Next.js** (App Router, standalone output) + **React 19**
- **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **Tailwind CSS** with CSS-variable design tokens (no remote fonts)
- **Zod** for runtime validation of config + all external connector responses
- **better-sqlite3** for bounded local history/event persistence
- **Vitest** + Testing Library (jsdom)

## Requirements

- Node.js >= 20 (developed/tested on Node 22)
- npm 10+

## Quick start (fake mode)

```bash
npm install
npm run dev            # http://localhost:3000
```

The app boots in **fake-data mode** by default and needs **no credentials**. It
serves deterministic simulator data so UI/dev work never touches real services.

## Data modes

`HOMELAB_DATA_MODE=fake` (default) or `live`. Fake and live return the exact same
normalized `DashboardSnapshot` shape, so the whole UI is identical in both.

### Fake scenarios

Set `HOMELAB_FAKE_SCENARIO` (or use the dev switcher / `?scenario=` in dev):

`idle`, `direct-play`, `transcode`, `multi-session`, `downloads`, `stalled`,
`connector-unavailable`, `stale`, `zfs-warning`, `zfs-degraded`, `unconfigured`,
`active`, `attention`, `container-field-real` (a sanitized 44-container
real-scale population), `container-field-stress` (above the 96-body render
budget, proving truthful overflow).

The screenshot harness drives the same scenarios with a frozen clock and stable
query parameters (`?scenario=…&freeze=…`, plus optional `panel=` / `drawer=`),
so review evidence is reproducible from a clean checkout.

**Committed review evidence is captured from a production build** (`--prod`:
`next build` + `next start`, dev controls enabled at runtime) with a headful
browser — dev-mode numbers include compile/HMR overhead and headless Chromium
has no real GPU path, so neither may back performance claims. Every artifact
records its build mode; the default dev-mode harness remains for iteration.

## Configuration

All server settings are parsed and validated once in `src/lib/env.server.ts`
(the single typed source of truth). See [`.env.example`](.env.example) for the
full annotated list. Highlights:

| Variable | Purpose |
| --- | --- |
| `HOMELAB_DATA_MODE` | `fake` or `live` |
| `HOMELAB_DB_PATH` | SQLite file (default `./data/homelab.db`) |
| `HOMELAB_QUICK_LINKS` | **Browser-facing** launcher links as JSON (see below) |
| `HOMELAB_HOST_LABEL` | Deliberate, non-secret topology label for the host |
| `HOMELAB_NETWORK_LINK_MBPS` | Physical link capacity used to scale gateway intensity |
| `JELLYFIN_URL` / `JELLYFIN_API_KEY` | Jellyfin connector |
| `HOMELAB_JELLYFIN_CONTAINER` | Exact Docker container name for measured Jellyfin egress/block-I/O fallback |
| `SONARR_URL` / `SONARR_API_KEY` | Sonarr connector |
| `RADARR_URL` / `RADARR_API_KEY` | Radarr connector |
| `QBITTORRENT_URL` / `_USERNAME` / `_PASSWORD` | qBittorrent connector |
| `SEERR_URL` / `SEERR_API_KEY` | Seerr/Jellyseerr media search + requests |
| `SEERR_REQUESTS_ENABLED` | Set `0` to keep Seerr search read-only |
| `ZFS_COLLECTOR_URL` / `_TOKEN` | ZFS helper-API mode |
| `HOMELAB_ZFS_COMMAND` | ZFS direct-command mode (`1`) |

**Connector fields are validated together.** A URL without its API key (or a qB
URL without credentials) is reported as an explicit *misconfiguration*, not
silently ignored. A connector with none of its fields set is simply "not
configured". All five core connectors always appear in the health strip so an
absent service is visible, never a mystery.

### Quick links vs connector URLs

`HOMELAB_QUICK_LINKS` are the URLs **your browser** opens (the dashboard may be
viewed from a laptop while services run on another host), deliberately separate
from the server-side connector base URLs. Only `http:`/`https:` schemes are
accepted. Example:

```
HOMELAB_QUICK_LINKS=[{"label":"Jellyfin","href":"https://jellyfin.example.lan"},{"label":"Sonarr","href":"https://sonarr.example.lan"}]
```

## Command palette

Press **⌘K / Ctrl+K** for a deterministic command palette (no LLM). It operates
only on the already-normalized snapshot: `open <service>`, `who is watching`,
`downloads`, `storage`, `issues`, `what was added today`. Unsupported input
returns helpful suggestions. With Seerr configured, `request <title>` /
`find movie <title>` hands off to the media search overlay.

## Media requests (Seerr / Jellyseerr)

With `SEERR_URL` + `SEERR_API_KEY` set, a quiet **Request media** affordance
appears on the media panel: search movies/TV (server-side via Seerr's
`/api/v1/search`), see truthful request/library state (`Available`,
`Pending approval`, `Processing`, partial TV), and request anything requestable
with one click (all seasons for an untracked series; only the missing seasons
for a partially tracked one).

**The approval contract is a hard postcondition**: the UI reports success only
after the backend has confirmed the Seerr request is `APPROVED`. If the create
call returns a pending request, the backend explicitly invokes Seerr's approval
endpoint and re-verifies; if approval cannot be confirmed, the request is
reported as **failed** — a dashboard-created request can never silently sit
waiting for a human administrator. What happens *after* approval (automatic
Radarr/Sonarr search, downloading) is your existing Seerr/Radarr/Sonarr
configuration's business; the dashboard neither requires nor triggers it, and it
only ever shows downloading/import state through the normal acquisition
connectors when they actually observe it.

The write path goes through the safe-action registry (`seerr.request`): the
browser supplies only `{ mediaType, mediaId }` — never Seerr routing parameters
(server/profile/root folder/user), never paths or headers — duplicate
submissions are deduped in-flight, and each outcome is audited plus surfaced in
the activity feed (`Requested and approved: …`). Posters are served through a
narrow same-origin proxy (`/api/seerr/poster`) that accepts only validated TMDB
poster paths, so the strict CSP and no-third-party-requests posture hold.
Legacy `JELLYSEERR_URL` / `JELLYSEERR_API_KEY` are accepted as aliases
(`SEERR_*` wins per-field); operators on Jellyseerr should be on a version
compatible with the Seerr v3 `/api/v1` contract.

## Persistence, attention & activity

- **History** (`better-sqlite3`): recent throughput samples, per-pool storage
  samples (30/90/365-day trend + capacity projection), activity
  events, health transitions, and alert lifecycle. Migrations run automatically
  on boot; a failed write is logged but never crashes rendering.
- **Bounded growth**: an hourly maintenance pass downsamples old high-frequency
  data into coarse buckets and enforces retention cutoffs, so the DB stays
  bounded over months. Storage is sampled only on a new ZFS observation.
- **Attention engine** (`src/lib/attention`): a deterministic rules engine with
  grace periods + hysteresis (connector unavailable, pool not ONLINE, capacity
  warning/critical, scrub errors, stalled/failed transfers). Health is *positively
  established* — an empty alert list is never assumed to mean "healthy"; when
  evaluation is incomplete the UI says "Status incomplete" rather than reassuring
  falsely.
- **Capacity projection** (`src/lib/dashboard/projection.ts`): daily-median
  reduction + Theil–Sen (robust median-pairwise) slope, shown only with enough
  history, positive growth, and a non-absurd estimate — presented as a
  subordinate "Estimated to reach 80% in ~N" line, never as prophecy.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build (standalone) |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | `next lint` |
| `npm run test` | Vitest suite once |
| `npm run verify` | typecheck + lint + test + build (the full gate) |
| `npm run audit:prod` | production dependency policy audit |
| `npm run compose:prod:config` | validate the production Compose topology |
| `npm run screenshots` | deterministic stills (dev server; iteration only) |
| `npm run screenshots:prod` | deterministic stills from a production build (committed evidence) |
| `npm run screenshots:motion` | deterministic motion/reduced-motion evidence |
| `npm run screenshots:performance:prod` | production-build performance JSON (headful GPU) |
| `npm run screenshots:determinism` | frozen-frame pixel identity under two system dates |
| `npm run smoke:example-env` | boots a production build under `.env.example` and asserts health + homepage |
| `npm run soak -- …` | deployed long-run RSS/DB-growth sampler |

CI (`.github/workflows/ci.yml`) runs `verify`, a secret scan (gitleaks) +
`npm audit`, and a Docker image build from a clean checkout.

## Deployment (Docker)

> Full operational runbook — update/rollback/backup, network topology, the ZFS
> collector, the security model, and the soak — lives in
> [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

The app is a **long-running Node server**: it holds in-process timers (connector
scheduler, aggregate loop, hourly maintenance) and last-known-good state. It is
**not** stateless/serverless-compatible — run it as a persistent process.

```bash
cp .env.example .env      # fill in connector URLs/keys (or leave blank for fake)
docker compose up -d --build
```

- SQLite persists on the `homelab-data` volume at `/data`; history survives
  restarts. Migrations run automatically on update.
- **Backup/restore**: stop the container and copy `homelab.db` (plus `-wal`/`-shm`
  if present) from the volume; restore by replacing them before start.
- **Update/rollback**: pull/rebuild and `docker compose up -d`. Because
  migrations are forward-only and additive, rolling *back* the image is safe as
  long as the newer migrations only added tables/columns (they do); keep a DB
  backup before a major upgrade.
- **Health**: `GET /api/health` is a liveness probe (200 while the process
  serves). It intentionally does **not** fail when an upstream service (e.g.
  Sonarr) is restarting — per-connector readiness is in `/api/dashboard`'s
  `health[]`. The container `HEALTHCHECK` uses it.
- Optional connectors that are unconfigured produce no scary errors — they render
  as "not set up".

### ZFS access model

The dashboard never runs browser-controlled shell. Pick one safe mode:

1. **Helper API** (preferred when containerized / off the ZFS host): a minimal
   read-only helper returning normalized pool JSON; set `ZFS_COLLECTOR_URL`
   (+ `ZFS_COLLECTOR_TOKEN`). Ships as `scripts/zfs-collector.mjs` (Node) or
   `scripts/zfs-collector.py` (Python), and as a compartmentalized **sidecar
   container** (`docker/zfs-collector.Dockerfile`) that reads ZFS via
   `--device=/dev/zfs` with `cap_drop: ALL`, `read_only`, and no host mounts —
   the dashboard container itself needs no ZFS access, no Docker socket, and no
   host privileges.
2. **Direct commands** (only when the process runs *on* the ZFS host): set
   `HOMELAB_ZFS_COMMAND=1`. The collector runs a *fixed argv*
   (`zpool list -Hp -o …`, `zpool status`) via `execFile` — no shell, no
   interpolation. Grant the service user read-only `zpool` access (e.g. a narrow
   sudoers rule), never broad privileges.

## Security & network model

- **Trust boundary**: the dashboard assumes a **private / LAN / Tailscale** network. There is
  no built-in authentication subsystem by design.
- **Reverse proxy**: if you expose the dashboard through Nginx Proxy Manager or
  similar, terminate **TLS** and add **authentication / access control** there,
  and keep any ZFS helper endpoint off the public internet.
- **Secrets** stay server-side: `env.server.ts` and every `*.server.ts` /
  connector module begin with `import "server-only"` (a client import is a build
  error). The browser only ever receives the normalized, secret-free snapshot.
- **No SSRF surface**: connector base URLs are administrator-controlled server
  config, never browser input — no browser request can make the server proxy an
  arbitrary URL. Quick-link and connector URLs are scheme-validated (`http`/
  `https` only).
- **qBittorrent privacy**: trackers, peer IPs, save paths, and raw infohashes are
  never read into the normalized payload.
- **Errors are sanitized**: `/api/dashboard` returns a generic message and logs a
  sanitized diagnostic server-side; connector errors never echo URLs/headers/
  bodies. No credentials, tokens, peer data, or paths are logged.
- **HTTP headers**: a tight CSP (self-only; `unsafe-inline` limited to
  script/style required by Next), `X-Content-Type-Options`, `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`, and a minimal `Permissions-Policy`.
- **No third-party analytics, telemetry, or remote fonts.**

## Architecture

```
src/
  app/
    page.tsx                     # SSR shell → the Living Topology client
    api/dashboard/route.ts       # the single normalized aggregate contract
    api/stream/route.ts          # SSE updates; client falls back to bounded polling
    api/health/route.ts          # liveness probe
    dev/flow-lab/page.tsx        # deterministic development-only flow fixture lab
  components/
    topology/                    # scene, overlays, metric rail, live-data transport
    ui/                          # shared accessible controls and overlay shell
  lib/
    types.ts                     # normalized, connector-agnostic domain types
    env.server.ts                # typed server config (server-only)
    snapshot.server.ts           # fake/live entry point + quick links
    config.ts / config.server.ts # non-secret config / connector-config resolution
    connectors/                  # per-service normalizers + runtime/hub/scheduler
    dashboard/                   # aggregate, health interpretation, projection, registry
    attention/                   # deterministic rules + engine (grace/hysteresis)
    pipeline/events.ts           # normalized cross-service activity events
    db/                          # schema/migrations, repository, retention/maintenance
    fake/                        # deterministic simulator
```

One failed service never breaks the homepage: the hub isolates each connector
(`Promise.allSettled`), the runtime keeps last-known-good across failures, and the
aggregate always returns a partial-but-valid snapshot.

The scene keeps two representations deliberately separate: the complete
normalized container set remains available to search and detail drawers, while
the canvas renders a deterministic bounded subset with an explicit `+N`
overflow marker. Unknown Docker states remain unknown; stale samples render
statically; network and flow intensity use measured counters, declared link
capacity, and explicit attribution rather than decorative estimates.

## Roadmap

See the Linear project for current status. Production deployment and the final
live-host smoke/soak gate are tracked separately from implementation; code in a
review branch is never assumed to be running production code.
