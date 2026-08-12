#!/usr/bin/env node
/**
 * Minimal, read-only ZFS collector helper (PLA-184 / PLA-206).
 *
 * WHY THIS EXISTS
 * ---------------
 * Reading ZFS pool state requires the `zpool` binary and access to `/dev/zfs`,
 * which live on the host. Rather than grant the dashboard container that access
 * (a broad, dangerous capability — `/dev/zfs`, CAP_SYS_ADMIN, or the host `zpool`
 * binary), this tiny service runs ON THE HOST and exposes ONLY normalized pool
 * JSON over an authenticated, network-restricted HTTP endpoint. The dashboard
 * container stays fully unprivileged and simply fetches this API
 * (HOMELAB `ZFS_COLLECTOR_URL` / `ZFS_COLLECTOR_TOKEN`).
 *
 * SAFETY PROPERTIES
 * -----------------
 *  - fixed argv only: `zpool list -Hp -o name,size,alloc,free,health` and
 *    `zpool status`. No shell, no interpolation, no command parameter from the
 *    request — the request cannot influence what runs.
 *  - read-only: there is no write/mutating endpoint.
 *  - authenticated: a constant-time bearer-token check (ZFS_COLLECTOR_TOKEN).
 *  - network-restricted: binds to ZFS_COLLECTOR_BIND (default 127.0.0.1). Bind
 *    it to the Docker bridge gateway (or use `host.docker.internal:host-gateway`
 *    from the container) so only local containers can reach it — never the LAN.
 *  - no dependencies: pure Node stdlib, so it runs on the host with just `node`.
 *
 * USAGE
 * -----
 *   ZFS_COLLECTOR_TOKEN=$(openssl rand -hex 32) \
 *   ZFS_COLLECTOR_BIND=172.17.0.1 \
 *   ZFS_COLLECTOR_PORT=9797 \
 *   node scripts/zfs-collector.mjs
 *
 * `zpool` typically needs root to read; run under systemd as root (it only ever
 * execs the two fixed read-only commands) or grant the service user read access.
 * See docs/DEPLOYMENT.md for a ready-to-use systemd unit.
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";

const execFileP = promisify(execFile);

const TOKEN = process.env.ZFS_COLLECTOR_TOKEN ?? "";
const BIND = process.env.ZFS_COLLECTOR_BIND ?? "127.0.0.1";
const PORT = Number(process.env.ZFS_COLLECTOR_PORT ?? 9797);
const EXEC_TIMEOUT_MS = 8000;

if (!TOKEN) {
  console.error("[zfs-collector] refusing to start: ZFS_COLLECTOR_TOKEN is required");
  process.exit(1);
}

/** Constant-time bearer check that never throws on odd input. */
function authorized(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(TOKEN);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/** Parse `zpool list -Hp -o name,size,alloc,free,health` (tab-separated, exact bytes). */
function parseList(stdout) {
  const pools = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    const [name, size, alloc, free, health] = cols;
    const sizeN = Number(size);
    const allocN = Number(alloc);
    const freeN = Number(free);
    if (!name || Number.isNaN(sizeN) || Number.isNaN(allocN)) continue;
    pools.push({
      name,
      size: sizeN,
      alloc: allocN,
      free: Number.isNaN(freeN) ? sizeN - allocN : freeN,
      health: (health ?? "").trim(),
      scanState: "none",
      lastScrubAt: null,
      scrubErrors: 0,
    });
  }
  return pools;
}

/** Merge `zpool status` scan/error info into the parsed pools (by name). */
function applyStatus(pools, stdout) {
  const byName = new Map(pools.map((p) => [p.name, p]));
  let current = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("pool:")) {
      current = byName.get(line.slice("pool:".length).trim()) ?? null;
    } else if (current && line.startsWith("scan:")) {
      const scan = line.slice("scan:".length).trim();
      if (/resilver in progress/i.test(scan)) current.scanState = "resilvering";
      else if (/in progress/i.test(scan)) current.scanState = "scrubbing";
      else if (/repaired|scrub|canceled/i.test(scan)) current.scanState = "finished";
      const withErrors = scan.match(/with (\d+) errors/i);
      if (withErrors) current.scrubErrors = Number(withErrors[1]);
      const on = scan.match(/ on (.+)$/);
      if (on) {
        const ts = Date.parse(on[1].trim().replace(/\s+/g, " "));
        if (!Number.isNaN(ts)) current.lastScrubAt = ts;
      }
    } else if (current && line.startsWith("errors:")) {
      const n = line.match(/(\d+) data errors/i);
      if (n) current.scrubErrors = Number(n[1]);
    }
  }
  return pools;
}

async function collect() {
  const [list, status] = await Promise.all([
    execFileP("zpool", ["list", "-Hp", "-o", "name,size,alloc,free,health"], { timeout: EXEC_TIMEOUT_MS }),
    execFileP("zpool", ["status"], { timeout: EXEC_TIMEOUT_MS }),
  ]);
  return { pools: applyStatus(parseList(list.stdout), status.stdout) };
}

const server = createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") return send(405, { error: "method not allowed" });
  if (!authorized(req.headers.authorization)) return send(401, { error: "unauthorized" });

  collect()
    .then((payload) => send(200, payload))
    // Never echo the underlying error (paths/argv) to the caller.
    .catch(() => send(503, { error: "zpool unavailable" }));
});

server.listen(PORT, BIND, () => {
  console.log(`[zfs-collector] listening on ${BIND}:${PORT} (read-only, token-auth)`);
});
