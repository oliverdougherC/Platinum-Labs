# 24-hour continuous-display soak (PLA-197)

The dashboard is meant to stay open for days on a secondary monitor, so PLA-197
requires a **literal 24-hour run**. `scripts/soak.mjs` is the instrument; this
document is the procedure and the acceptance gate.

## What the harness records

`node scripts/soak.mjs` polls `/api/dashboard` like a browser and writes an
NDJSON row every `--sample` seconds with:

- `polls`, `failures`, `lastStatus` — request health over time
- `containerRssBytes` — Compose container memory usage when `--compose-service` is used
- `serverRssKb` — host-process RSS when `--pid` is used instead of Compose
- `dbBytes` — SQLite file size across `.db`, `-wal`, and `-shm`
- `throughputSamplesRows`, `storageSamplesRows`, `activityEventsRows` — logical row growth
- `pageCount`, `freelistCount` — SQLite page allocator state

For real deployments, prefer Compose mode so the harness samples the running
container and the actual mounted DB volume in place.

## Recommended production command

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

The default duration is already `86400`, but the requirement is explicit: do not
shorten the acceptance run below 24 hours. Shorter runs are smoke checks only.

## Fallback host-process command

When you are not using Docker Compose, point the harness at the process PID and
DB path directly:

```bash
HOMELAB_DATA_MODE=live PORT=3000 npm run start &
SRV=$(lsof -ti :3000 | head -1)

npm run soak -- \
  --url http://localhost:3000 \
  --duration 86400 \
  --interval 7 \
  --sample 60 \
  --pid "$SRV" \
  --db ./data/homelab.db \
  --out soak-report.ndjson
```

## Procedure

1. Start the real deployment and leave a real browser tab open on the secondary display.
2. Run the harness for the full 24 hours with `--duration 86400`.
3. Observe natural upstream recovery if a service restarts. Do **not** restart
   production Jellyfin, Sonarr, Radarr, qBittorrent, Docker, or ZFS merely to
   satisfy the soak. Exercise recovery with a disposable connector when
   practical, and cite the deterministic recovery tests for paths that cannot
   be disrupted safely.
4. Background and foreground the tab and let the display sleep/wake at least once.
5. Review the report and the final summary printed by the harness.

Quick inspection:

```bash
node -e '
  const rows = require("node:fs").readFileSync("soak-report.ndjson", "utf8").trim().split("\n").map(JSON.parse);
  for (const row of rows.slice(-10)) {
    console.log(
      row.elapsedS,
      row.failures,
      row.lastStatus,
      row.containerRssBytes ?? row.serverRssKb,
      row.dbBytes,
      row.throughputSamplesRows,
      row.storageSamplesRows,
      row.activityEventsRows,
      row.pageCount,
      row.freelistCount,
    );
  }
'
```

## Pass criteria

- **Literal runtime**: the final sample must show `elapsedS >= 86400`.
- **Recovery**: any natural or disposable-test outage is bounded and recovers
  without a manual page reload; deterministic recovery tests cover production
  connectors that were not safely disrupted.
- **Bounded memory**: container RSS (or host RSS in fallback mode) returns to a
  stable band instead of climbing monotonically for 24 hours.
- **Bounded logical growth**: `throughput_samples`, `storage_samples`, and
  `activity_events` grow only with real work and remain consistent with the app's
  retention/downsampling model. A straight-line increase with no plateau or reuse
  signal is a failure.
- **Bounded physical growth**: `dbBytes`, `pageCount`, and `freelistCount` stay
  in a believable band for the observed activity. Growth followed by freelist
  reuse is acceptable; unbounded page growth is not.
- **Browser behavior**: no runaway DOM accumulation, no animation degradation,
  reduced-motion still respected, and sleep/wake/background transitions recover.

## Status

The harness is committed and smoke-testable in development. The actual 24-hour
acceptance run must still be executed on a persistent host against a real
deployment before PLA-197 is closed.

## V4 Kinetic Canvas renderer soak (client-side)

The server soak above proves the backend; the V4 kinetic renderer has its own
client-side soak because its risk profile is different: a canvas surface that
must animate continuously for hours without heap growth, listener
accumulation, ghost-flow buildup, duplicate animation loops, or degrading
frames.

```bash
npm run soak:kinetic          # 90-minute headful production soak (the gate)
node scripts/soak-kinetic.mjs --minutes 5 --headless   # smoke iteration
```

The harness keeps ONE mounted production kinetic stage (`/?ui=kinetic`) alive
with no reloads, cycles realistic operational states through the fixture hook
(downloads, seeding, playback, transcode, simultaneous activity, imports,
attention, quiet) including inspector open/close, and samples CDP metrics plus
bounded engine counters every 5 minutes. It forces GC at the baseline and end
and FAILS on retained-heap growth, listener/DOM accumulation, unbounded
flow/ghost/particle state, a stage remount, or a monotonic heap climb. The
committed report lives at `docs/review/v4-kinetic-flow/soak-90min.json`.
