# 24-hour continuous-display soak (PLA-197)

The dashboard is designed to stay open for days on a secondary monitor, so this
is a real product requirement, not a formality. `scripts/soak.mjs` is the
instrument; this document is the procedure. **A unit test that loops synthetic
snapshots does not satisfy PLA-197 — a real 24-hour run must actually happen and
its acceptance criteria be observed.**

## What the harness measures

`node scripts/soak.mjs` polls `/api/dashboard` like a browser and writes an
NDJSON row every `--sample` seconds with:

- `serverRssKb` — server process resident memory (via `ps`, needs `--pid`)
- `dbBytes` — SQLite file size (`.db` + `-wal` + `-shm`)
- `polls`, `failures`, `lastStatus` — request health over time

## Procedure

1. Start the server in **live** mode against your real homelab (or fake mode for a
   dry run), and note its PID:

   ```bash
   HOMELAB_DATA_MODE=live PORT=3000 npm run start &
   SRV=$(lsof -ti :3000 | head -1)
   ```

2. Run the harness for 24 hours (7s browser-like cadence, 60s samples):

   ```bash
   npm run soak -- --url http://localhost:3000 --duration 86400 \
     --interval 7 --sample 60 --pid "$SRV" --db ./data/homelab.db \
     --out soak-report.ndjson
   ```

3. **During the run, restart each upstream service at least once** (Jellyfin,
   Sonarr, Radarr, qBittorrent, and the ZFS source) so recovery is exercised, and
   leave a real browser tab open on the monitor to observe the visual/animation
   behaviour and to background/foreground the tab and sleep/wake the display.

4. Afterwards, inspect `soak-report.ndjson`:

   ```bash
   # memory + db size trend
   node -e "for(const l of require('fs').readFileSync('soak-report.ndjson','utf8').trim().split('\n')){const r=JSON.parse(l);console.log(r.elapsedS,'s',(r.serverRssKb/1024|0)+'MB',(r.dbBytes/1024|0)+'KB',r.failures)}"
   ```

## Pass criteria (observe, don't assume)

- **Server RSS** returns to a stable band — no monotonic upward drift over 24h.
- **SQLite** size levels off (bounded by retention/downsampling; the hourly
  maintenance pass runs — see `runMaintenance`), not linear growth.
- **Polls vs failures**: failures only during the deliberate restarts, each
  followed by automatic recovery (status back to 200) with no manual reload.
- **No polling explosion**: `polls` grows linearly at ~`duration/interval`.
- **Browser tab**: no unbounded browser memory growth (DevTools → Memory), chart
  DOM node count stable (charts update in place, they don't append), ambient
  animation stays smooth, reduced-motion respected, keyboard focus works, and the
  page recovers after monitor sleep/wake and tab backgrounding.

## Status

Automated instrument: **done and smoke-tested**. The real 24-hour observation
requires a persistent host + real (restartable) connectors and has **not** been
run in the development environment — this issue stays open until it is executed
and its measurements recorded here.
