import "server-only";

import { getServerEnv } from "@/lib/env.server";
import { appConfig } from "@/lib/config";
import { fetchJson } from "@/lib/connectors/http";
import { ConnectorRuntime } from "@/lib/connectors/runtime";
import { ConnectorHub } from "@/lib/connectors/hub";
import { PollScheduler } from "@/lib/connectors/scheduler";
import { createJellyfinConnector, type HttpGet } from "@/lib/connectors/jellyfin";
import { createSonarrConnector, createRadarrConnector } from "@/lib/connectors/servarr";
import { createQbittorrentConnector, type QbClient } from "@/lib/connectors/qbittorrent";
import { createZfsConnector } from "@/lib/connectors/zfs";
import { makeCommandCollect, makeHelperCollect } from "@/lib/connectors/zfs.server";
import { assembleSnapshot } from "@/lib/dashboard/aggregate";
import { getDb, tryPersist } from "@/lib/db/db.server";
import {
  insertActivityEvent,
  insertStorageSample,
  insertThroughput,
  recentThroughput,
  recordHealthTransition,
  storageTrend,
} from "@/lib/db/repository";
import { deriveEvents } from "@/lib/pipeline/events";
import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  DashboardHistory,
  DashboardSnapshot,
  JellyfinSnapshot,
  ZfsSnapshot,
} from "@/lib/types";

/**
 * Live registry (PLA-186) — `server-only`.
 *
 * Builds connectors from validated env, runs them on the shared scheduler
 * (upstream cadence), and — on a SEPARATE, slower loop — assembles the cached
 * aggregate snapshot, samples history, derives+persists events, and records
 * health transitions. The API reads only the cached snapshot, so browser
 * refreshes never trigger upstream polls (no N+1) and one failing connector
 * yields a partial snapshot rather than an error.
 */

const httpGet: HttpGet = (url, opts) => fetchJson(url, opts);

interface LiveRegistry {
  hub: ConnectorHub;
  scheduler: PollScheduler;
  jellyfinRt: ConnectorRuntime<JellyfinSnapshot> | null;
  sonarrRt: ConnectorRuntime<AcquisitionItem[]> | null;
  radarrRt: ConnectorRuntime<AcquisitionItem[]> | null;
  qbRt: ConnectorRuntime<AcquisitionSnapshot> | null;
  zfsRt: ConnectorRuntime<ZfsSnapshot> | null;
}

let registry: LiveRegistry | null = null;
let cached: DashboardSnapshot | null = null;
let prevForEvents: DashboardSnapshot | null = null;
let assembleTimer: ReturnType<typeof setInterval> | null = null;

/** Minimal cookie-authenticated qBittorrent client (server-only). */
function makeQbClient(base: string, username: string, password: string): QbClient {
  const root = base.replace(/\/$/, "");
  let sid: string | null = null;

  async function login(signal: AbortSignal): Promise<void> {
    const res = await fetch(`${root}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      signal,
      cache: "no-store",
    });
    const cookies = res.headers.getSetCookie?.() ?? [];
    const sidCookie = cookies.find((c) => c.startsWith("SID="));
    sid = sidCookie ? sidCookie.split(";")[0]!.slice("SID=".length) : null;
  }

  async function get(path: string, signal: AbortSignal): Promise<unknown> {
    if (!sid) await login(signal);
    const res = await fetch(`${root}${path}`, {
      headers: sid ? { Cookie: `SID=${sid}` } : {},
      signal,
      cache: "no-store",
    });
    if (res.status === 403) {
      await login(signal);
      return get(path, signal);
    }
    return res.json();
  }

  return {
    torrentsInfo: (signal) => get("/api/v2/torrents/info", signal),
    transferInfo: (signal) => get("/api/v2/transfer/info", signal),
  };
}

function build(): LiveRegistry {
  const env = getServerEnv();
  const hub = new ConnectorHub();
  const runtimes: ConnectorRuntime<unknown>[] = [];
  const p = appConfig.pollIntervalsMs;

  const jellyfinRt =
    env.JELLYFIN_URL && env.JELLYFIN_API_KEY
      ? new ConnectorRuntime(
          createJellyfinConnector(
            { url: env.JELLYFIN_URL, apiKey: env.JELLYFIN_API_KEY, pollIntervalMs: p.jellyfin },
            httpGet,
          ),
        )
      : null;

  const sonarrRt =
    env.SONARR_URL && env.SONARR_API_KEY
      ? new ConnectorRuntime(
          createSonarrConnector(
            { url: env.SONARR_URL, apiKey: env.SONARR_API_KEY, pollIntervalMs: p.sonarr },
            httpGet,
          ),
        )
      : null;

  const radarrRt =
    env.RADARR_URL && env.RADARR_API_KEY
      ? new ConnectorRuntime(
          createRadarrConnector(
            { url: env.RADARR_URL, apiKey: env.RADARR_API_KEY, pollIntervalMs: p.radarr },
            httpGet,
          ),
        )
      : null;

  const qbRt =
    env.QBITTORRENT_URL && env.QBITTORRENT_USERNAME && env.QBITTORRENT_PASSWORD
      ? new ConnectorRuntime(
          createQbittorrentConnector(
            { pollIntervalMs: p.qbittorrent },
            makeQbClient(env.QBITTORRENT_URL, env.QBITTORRENT_USERNAME, env.QBITTORRENT_PASSWORD),
          ),
        )
      : null;

  const zfsRt = env.ZFS_COLLECTOR_URL
    ? new ConnectorRuntime(
        createZfsConnector(
          { pollIntervalMs: p.zfs },
          makeHelperCollect(env.ZFS_COLLECTOR_URL, env.ZFS_COLLECTOR_TOKEN),
        ),
      )
    : process.env.HOMELAB_ZFS_COMMAND === "1"
      ? new ConnectorRuntime(
          createZfsConnector({ pollIntervalMs: p.zfs }, makeCommandCollect()),
        )
      : null;

  for (const rt of [jellyfinRt, sonarrRt, radarrRt, qbRt, zfsRt]) {
    if (rt) {
      hub.register(rt as ConnectorRuntime<unknown>);
      runtimes.push(rt as ConnectorRuntime<unknown>);
    }
  }

  return {
    hub,
    scheduler: new PollScheduler(hub, runtimes),
    jellyfinRt,
    sonarrRt,
    radarrRt,
    qbRt,
    zfsRt,
  };
}

function assemble(reg: LiveRegistry, now: number): DashboardSnapshot {
  return assembleSnapshot({
    now,
    health: reg.hub.health(),
    jellyfin: reg.jellyfinRt?.getState().snapshot ?? null,
    sonarr: reg.sonarrRt?.getState().snapshot ?? null,
    radarr: reg.radarrRt?.getState().snapshot ?? null,
    qbittorrent: reg.qbRt?.getState().snapshot ?? null,
    zfs: reg.zfsRt?.getState().snapshot ?? null,
    history: readHistory(now),
  });
}

function readHistory(now: number): DashboardHistory {
  try {
    const db = getDb();
    const throughput = recentThroughput(db, now, 45 * 60_000).map((s) => ({
      t: s.t,
      bps: s.bps,
    }));
    const rows = storageTrend(db, now, 30);
    const byT = new Map<number, { t: number } & Record<string, number>>();
    const series = new Set<string>();
    for (const r of rows) {
      series.add(r.pool);
      const row = byT.get(r.t) ?? { t: r.t };
      row[r.pool] = r.usedBytes;
      byT.set(r.t, row);
    }
    return {
      throughput,
      storageSeries: [...series],
      storage: [...byT.values()].sort((a, b) => a.t - b.t),
    };
  } catch {
    return { throughput: [], storageSeries: [], storage: [] };
  }
}

function persist(snapshot: DashboardSnapshot, now: number): void {
  tryPersist((db) => {
    // Sample throughput + storage for the charts.
    insertThroughput(db, { t: now, bps: snapshot.acquisition.rollup.aggregateRateBps });
    for (const pool of snapshot.zfs.pools) {
      insertStorageSample(db, {
        t: now,
        pool: pool.name,
        usedBytes: pool.usedBytes,
        totalBytes: pool.totalBytes,
      });
    }
    // Health transitions (deduped inside the repository).
    for (const h of snapshot.health) recordHealthTransition(db, now, h.id, h.status);
    // Derived activity events (idempotent by id).
    for (const ev of deriveEvents(prevForEvents, snapshot)) insertActivityEvent(db, ev);
  });
}

function assembleAndPersist(reg: LiveRegistry, now: number): void {
  const snapshot = assemble(reg, now);
  persist(snapshot, now);
  prevForEvents = snapshot;
  cached = snapshot;
}

function ensureStarted(reg: LiveRegistry): void {
  if (reg.scheduler.isRunning) return;
  reg.scheduler.start();
  assembleAndPersist(reg, Date.now());
  assembleTimer = setInterval(() => assembleAndPersist(reg, Date.now()), 5_000);
  if (assembleTimer && typeof assembleTimer === "object" && "unref" in assembleTimer) {
    assembleTimer.unref();
  }
}

/** Live aggregate snapshot from the server cache (no upstream call per request). */
export async function getLiveSnapshot(): Promise<DashboardSnapshot> {
  if (!registry) registry = build();
  ensureStarted(registry);
  if (!cached) assembleAndPersist(registry, Date.now());
  return cached ?? assemble(registry, Date.now());
}
