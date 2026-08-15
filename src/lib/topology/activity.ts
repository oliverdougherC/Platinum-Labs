/**
 * Real activity → topology flows (PLA-267) — pure, tested.
 *
 * Derives which flow paths are alive and how intensely, from the normalized
 * snapshot. Hard rules:
 *
 *  - motion only from REAL state: no downloads → no acquisition flows, no
 *    sessions → no playback flows, ever;
 *  - stale sources are suppressed (stale must not read as active);
 *  - throughput maps through a deadband + log scale, so background noise
 *    never animates and fifty transfers do not spawn fifty streams —
 *    acquisition aggregates into ONE flow per edge.
 */

import {
  intensityFromRate,
  FLOW_DEADBAND_BPS,
} from "@/lib/topology/smoothing";
import { isConnectorStale } from "@/lib/types";
import type { FlowId } from "@/lib/topology/layout";
import type { DashboardSnapshot } from "@/lib/types";

export interface FlowState {
  id: FlowId;
  /** 0..1 visual intensity (log-scaled throughput). */
  intensity: number;
  /** Pool the flow targets/sources, for parameterized paths. */
  pool?: string;
}

function staleSource(
  snapshot: DashboardSnapshot,
  id: "jellyfin" | "sonarr" | "radarr" | "qbittorrent",
  now: number,
): boolean {
  const health = snapshot.health.find((h) => h.id === id);
  if (!health) return true;
  if (!health.configured) return true;
  if (health.status === "unavailable") return true;
  return isConnectorStale(health, now);
}

/** The pool currently receiving the most write throughput (import target). */
export function dominantWritePool(snapshot: DashboardSnapshot): string | null {
  const disk = snapshot.telemetry.disk;
  if (disk.status !== "available" || !disk.value) return null;
  let best: string | null = null;
  let bestRate = FLOW_DEADBAND_BPS;
  for (const pool of disk.value.pools) {
    if (pool.pool === "other") continue;
    if (pool.writeBps > bestRate) {
      best = pool.pool;
      bestRate = pool.writeBps;
    }
  }
  return best;
}

/** The pool currently serving the most read throughput (playback source). */
export function dominantReadPool(snapshot: DashboardSnapshot): string | null {
  const disk = snapshot.telemetry.disk;
  if (disk.status !== "available" || !disk.value) return null;
  let best: string | null = null;
  let bestRate = FLOW_DEADBAND_BPS;
  for (const pool of disk.value.pools) {
    if (pool.pool === "other") continue;
    if (pool.readBps > bestRate) {
      best = pool.pool;
      bestRate = pool.readBps;
    }
  }
  return best;
}

const DEFAULT_MEDIA_POOL = "DataStore";

/** Derive every live flow from the snapshot. Idle input → empty array. */
export function deriveFlows(snapshot: DashboardSnapshot, now: number): FlowState[] {
  const flows: FlowState[] = [];
  const acq = snapshot.acquisition;
  const qbStale = staleSource(snapshot, "qbittorrent", now);
  const sonarrStale = staleSource(snapshot, "sonarr", now);
  const radarrStale = staleSource(snapshot, "radarr", now);
  const jellyfinStale = staleSource(snapshot, "jellyfin", now);

  // --- acquisition: network edge → downloader → arr ---------------------------
  const downloadRate = acq.rollup.aggregateRateBps;
  const downloading = acq.rollup.downloading > 0 && downloadRate >= FLOW_DEADBAND_BPS;
  if (downloading && !qbStale) {
    const intensity = intensityFromRate(downloadRate);
    flows.push({ id: "ingress-qbittorrent", intensity });
    // Fan out to the arr that owns active downloads — aggregated per edge, one
    // flow per service regardless of item count.
    const sonarrActive = acq.items.some(
      (i) => i.source === "sonarr" && i.state === "downloading",
    );
    const radarrActive = acq.items.some(
      (i) => i.source === "radarr" && i.state === "downloading",
    );
    if (sonarrActive && !sonarrStale) {
      flows.push({ id: "qbittorrent-sonarr", intensity: intensity * 0.8 });
    }
    if (radarrActive && !radarrStale) {
      flows.push({ id: "qbittorrent-radarr", intensity: intensity * 0.8 });
    }
  }

  // --- import: arr → storage --------------------------------------------------
  const importing = acq.rollup.importing > 0;
  if (importing && !(sonarrStale && radarrStale)) {
    const pool = dominantWritePool(snapshot) ?? DEFAULT_MEDIA_POOL;
    const writeRate =
      snapshot.telemetry.disk.status === "available"
        ? snapshot.telemetry.disk.value?.pools.find((p) => p.pool === pool)?.writeBps ?? 0
        : 0;
    flows.push({
      id: "import-datastore",
      // Imports are real even when disk telemetry is missing — floor at a calm
      // visible minimum, scale up with actual write throughput.
      intensity: Math.max(0.25, intensityFromRate(writeRate)),
      pool,
    });
  }

  // --- playback: storage → Jellyfin → network edge ----------------------------
  const sessions = snapshot.jellyfin.sessions;
  if (sessions.length > 0 && !jellyfinStale) {
    const totalBitrateBps =
      sessions.reduce((sum, s) => sum + (s.bitrateBps ?? 0), 0) / 8;
    const intensity = Math.max(0.22, intensityFromRate(totalBitrateBps, 40_000_000, 50_000));
    const pool = dominantReadPool(snapshot) ?? DEFAULT_MEDIA_POOL;
    flows.push({ id: "storage-jellyfin", intensity, pool });
    flows.push({ id: "jellyfin-egress", intensity });
  }

  return flows;
}
