/**
 * Aggregate assembler (PLA-186).
 *
 * Combines the individual connector snapshots (which may be null when a
 * connector is unavailable) plus health, attention, activity, and history into
 * the one `DashboardSnapshot` the client contract exposes. Pure and testable:
 * a missing connector yields a partial-but-valid snapshot (never an error), so
 * the API can always return 200 with whatever is healthy.
 */

import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  ActivityEvent,
  AttentionItem,
  ConnectorHealth,
  DashboardHistory,
  DashboardSnapshot,
  JellyfinSnapshot,
  ZfsSnapshot,
} from "@/lib/types";

export interface AggregateParts {
  now: number;
  health: ConnectorHealth[];
  jellyfin: JellyfinSnapshot | null;
  sonarr: AcquisitionItem[] | null;
  radarr: AcquisitionItem[] | null;
  qbittorrent: AcquisitionSnapshot | null;
  zfs: ZfsSnapshot | null;
  attention?: AttentionItem[];
  activity?: ActivityEvent[];
  history?: DashboardHistory;
}

const JELLYFIN_UNAVAILABLE: JellyfinSnapshot = {
  serverAvailable: false,
  version: null,
  sessions: [],
  lastPlaybackAt: null,
};

export function mergeAcquisition(
  sonarr: AcquisitionItem[] | null,
  radarr: AcquisitionItem[] | null,
  qbittorrent: AcquisitionSnapshot | null,
): AcquisitionSnapshot {
  const items = [
    ...(sonarr ?? []),
    ...(radarr ?? []),
    ...(qbittorrent?.items ?? []),
  ];

  // qBittorrent's global download speed is the authoritative live throughput;
  // fall back to summing per-item rates for the *arr-only case.
  const summedRates = items.reduce((sum, i) => sum + (i.rateBps ?? 0), 0);
  const aggregateRateBps =
    qbittorrent?.rollup.aggregateRateBps ?? summedRates;

  return {
    items,
    rollup: {
      downloading: items.filter((i) => i.state === "downloading").length,
      importing: items.filter((i) => i.state === "importing").length,
      failedOrStalled: items.filter(
        (i) => i.state === "stalled" || i.state === "failed",
      ).length,
      aggregateRateBps: Math.max(0, Math.round(aggregateRateBps)),
    },
  };
}

export function assembleSnapshot(parts: AggregateParts): DashboardSnapshot {
  return {
    mode: "live",
    generatedAt: parts.now,
    health: parts.health,
    jellyfin: parts.jellyfin ?? JELLYFIN_UNAVAILABLE,
    acquisition: mergeAcquisition(parts.sonarr, parts.radarr, parts.qbittorrent),
    zfs: parts.zfs ?? { pools: [] },
    attention: parts.attention ?? [],
    activity: parts.activity ?? [],
    history: parts.history,
  };
}
