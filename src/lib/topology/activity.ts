/**
 * Real activity → topology flows (PLA-267/275) — pure, tested.
 *
 * Derives which semantic flows are alive and how intensely, from the
 * normalized snapshot. Flows are edges between semantic endpoints; the
 * renderer decides geometry. Hard rules:
 *
 *  - motion only from REAL state: no downloads → no acquisition flows, no
 *    sessions → no playback flows, ever;
 *  - the rendered pipeline is the real pipeline: network → downloader →
 *    Sonarr/Radarr → storage. The import edge belongs to the Arr that is
 *    actually importing, never a shortcut from the downloader to a pool;
 *  - every flow is gated on the freshness of the EXACT source that justifies it —
 *    a stale Sonarr suppresses Sonarr's import edge even while Radarr is
 *    healthy, and vice versa;
 *  - storage identity is never inferred from dominant pool I/O (unrelated
 *    writes/reads must not redirect a flow). Media flows attach to the
 *    operator-declared pool (`snapshot.mediaPool`) when it exists, otherwise
 *    to a deliberately generic storage endpoint. Less specific beats
 *    confidently wrong;
 *  - throughput maps through a deadband + log scale, and acquisition
 *    aggregates into ONE flow per edge regardless of item count.
 */

import {
  intensityFromRate,
  FLOW_DEADBAND_BPS,
} from "@/lib/topology/smoothing";
import { isConnectorStale } from "@/lib/types";
import type { DashboardSnapshot } from "@/lib/types";

export type ServiceEndpointId = "jellyfin" | "sonarr" | "radarr" | "qbittorrent";

/** A semantic flow endpoint. The renderer maps these onto scene bodies. */
export type FlowEndpoint =
  | { kind: "network" }
  | { kind: "service"; id: ServiceEndpointId }
  | { kind: "pool"; name: string }
  /** Generic storage: media landed/served on disk but no pool was declared. */
  | { kind: "storage" };

export type FlowKind = "download" | "handoff" | "import" | "playback" | "egress";

export interface FlowState {
  /** Stable id derived from kind + endpoints (safe as a React/render key). */
  id: string;
  kind: FlowKind;
  from: FlowEndpoint;
  to: FlowEndpoint;
  /** 0..1 visual intensity (log-scaled throughput). */
  intensity: number;
}

function endpointKey(e: FlowEndpoint): string {
  switch (e.kind) {
    case "network":
      return "network";
    case "service":
      return e.id;
    case "pool":
      return `pool:${e.name}`;
    case "storage":
      return "storage";
  }
}

function flow(
  kind: FlowKind,
  from: FlowEndpoint,
  to: FlowEndpoint,
  intensity: number,
): FlowState {
  return {
    id: `${kind}:${endpointKey(from)}->${endpointKey(to)}`,
    kind,
    from,
    to,
    intensity,
  };
}

function staleSource(
  snapshot: DashboardSnapshot,
  id: ServiceEndpointId,
  now: number,
): boolean {
  const health = snapshot.health.find((h) => h.id === id);
  if (!health) return true;
  if (!health.configured) return true;
  if (health.status === "unavailable") return true;
  return isConnectorStale(health, now);
}

/**
 * Where media flows meet storage. ONLY the operator-declared pool
 * (`snapshot.mediaPool`) may name a pool; when it is unset or names a pool
 * that does not exist, the endpoint is generic storage. Dominant-I/O
 * inference is deliberately absent (PLA-275).
 */
export function mediaStorageEndpoint(snapshot: DashboardSnapshot): FlowEndpoint {
  const declared = snapshot.mediaPool ?? null;
  if (declared && snapshot.zfs.pools.some((p) => p.name === declared)) {
    return { kind: "pool", name: declared };
  }
  return { kind: "storage" };
}

/**
 * Write throughput evidence for the declared media pool, used only to scale
 * an already-justified import flow. Returns null when the endpoint is generic
 * or disk telemetry is missing — never a reason to invent or retarget a flow.
 */
function declaredPoolWriteBps(
  snapshot: DashboardSnapshot,
  target: FlowEndpoint,
): number | null {
  if (target.kind !== "pool") return null;
  const disk = snapshot.telemetry.disk;
  if (disk.status !== "available" || !disk.value) return null;
  return disk.value.pools.find((p) => p.pool === target.name)?.writeBps ?? null;
}

/** Derive every live flow from the snapshot. Idle input → empty array. */
export function deriveFlows(snapshot: DashboardSnapshot, now: number): FlowState[] {
  const flows: FlowState[] = [];
  const acq = snapshot.acquisition;
  const qbStale = staleSource(snapshot, "qbittorrent", now);
  const sonarrStale = staleSource(snapshot, "sonarr", now);
  const radarrStale = staleSource(snapshot, "radarr", now);
  const jellyfinStale = staleSource(snapshot, "jellyfin", now);
  const storage = mediaStorageEndpoint(snapshot);

  // --- acquisition: network → downloader → arr --------------------------------
  const downloadRate = acq.rollup.aggregateRateBps;
  const downloading = acq.rollup.downloading > 0 && downloadRate >= FLOW_DEADBAND_BPS;
  if (downloading && !qbStale) {
    const intensity = intensityFromRate(downloadRate);
    flows.push(
      flow("download", { kind: "network" }, { kind: "service", id: "qbittorrent" }, intensity),
    );
    // Hand off to the arr(s) that own active downloads — one aggregated flow
    // per service edge regardless of item count, each gated on ITS source.
    for (const arr of ["sonarr", "radarr"] as const) {
      const arrStale = arr === "sonarr" ? sonarrStale : radarrStale;
      const active = acq.items.some(
        (i) => i.source === arr && i.state === "downloading",
      );
      if (active && !arrStale) {
        flows.push(
          flow(
            "handoff",
            { kind: "service", id: "qbittorrent" },
            { kind: "service", id: arr },
            intensity * 0.8,
          ),
        );
      }
    }
  }

  // --- import: the arr ACTUALLY importing → storage ---------------------------
  // Never downloader → storage, and never a pool chosen by write activity:
  // each arr's own importing queue items justify each edge (PLA-275).
  for (const arr of ["sonarr", "radarr"] as const) {
    const arrStale = arr === "sonarr" ? sonarrStale : radarrStale;
    const importing = acq.items.some(
      (i) => i.source === arr && i.state === "importing",
    );
    if (!importing || arrStale) continue;
    // Imports are real even when disk telemetry is missing — floor at a calm
    // visible minimum; scale up only with the DECLARED pool's write rate.
    const writeBps = declaredPoolWriteBps(snapshot, storage);
    const intensity = Math.max(0.25, intensityFromRate(writeBps ?? 0));
    flows.push(flow("import", { kind: "service", id: arr }, storage, intensity));
  }

  // --- playback: storage → Jellyfin → network ---------------------------------
  const sessions = snapshot.jellyfin.sessions;
  if (sessions.length > 0 && !jellyfinStale) {
    const totalBitrateBps =
      sessions.reduce((sum, s) => sum + (s.bitrateBps ?? 0), 0) / 8;
    const intensity = Math.max(0.22, intensityFromRate(totalBitrateBps, 40_000_000, 50_000));
    flows.push(flow("playback", storage, { kind: "service", id: "jellyfin" }, intensity));
    flows.push(
      flow("egress", { kind: "service", id: "jellyfin" }, { kind: "network" }, intensity),
    );
  }

  return flows;
}
