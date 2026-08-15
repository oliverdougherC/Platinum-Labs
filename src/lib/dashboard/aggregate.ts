/**
 * Aggregate assembler (PLA-186).
 *
 * Combines the individual connector snapshots (which may be null when a
 * connector is unavailable) plus health, attention, activity, and history into
 * the one `DashboardSnapshot` the client contract exposes. Pure and testable:
 * a missing connector yields a partial-but-valid snapshot (never an error), so
 * the API can always return 200 with whatever is healthy.
 */

import { emptyTelemetry, notConfiguredTelemetry } from "@/lib/telemetry/normalize";
import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  AcquisitionState,
  ActivityEvent,
  AttentionItem,
  ConnectorHealth,
  ConnectorId,
  DashboardHistory,
  DashboardSnapshot,
  HostTelemetrySnapshot,
  JellyfinSnapshot,
  TelemetryHistory,
  ZfsSnapshot,
} from "@/lib/types";

/** The core connectors that must always appear in `health`. */
export const CORE_CONNECTORS: ConnectorId[] = [
  "jellyfin",
  "sonarr",
  "radarr",
  "qbittorrent",
  "zfs",
  "host",
];

/** Config classification for a connector that has no live runtime. */
export interface ConnectorConfigStatus {
  /** True only when fully configured (never true for `partial`). */
  configured: boolean;
  /** Sanitized "missing field" message for a half-configured connector. */
  configError: string | null;
  pollIntervalMs: number;
}

/**
 * Ensure a health record exists for *every* core connector. Connectors with a
 * live runtime keep their real health; absent/misconfigured ones get an explicit
 * placeholder so the UI can render "not set up" / "misconfigured" instead of the
 * connector silently vanishing (Phase 1.5). Empty payloads from an absent
 * connector must never read as a healthy empty state.
 */
export function fillConnectorHealth(
  present: ConnectorHealth[],
  configStatus: Record<ConnectorId, ConnectorConfigStatus>,
): ConnectorHealth[] {
  const byId = new Map(present.map((h) => [h.id, h]));
  return CORE_CONNECTORS.map((id) => {
    const live = byId.get(id);
    if (live) return live;
    const cfg = configStatus[id];
    return {
      id,
      status: "unavailable",
      configured: cfg.configured,
      lastSuccessAt: null,
      lastError: null,
      configError: cfg.configError,
      pollIntervalMs: cfg.pollIntervalMs,
    };
  });
}

export interface AggregateParts {
  now: number;
  health: ConnectorHealth[];
  jellyfin: JellyfinSnapshot | null;
  sonarr: AcquisitionItem[] | null;
  radarr: AcquisitionItem[] | null;
  qbittorrent: AcquisitionSnapshot | null;
  zfs: ZfsSnapshot | null;
  /** Host telemetry; null when the collector has never produced a snapshot. */
  telemetry?: HostTelemetrySnapshot | null;
  /** True when no host collector is configured at all (vs. failing). */
  telemetryNotConfigured?: boolean;
  telemetryHistory?: TelemetryHistory;
  attention?: AttentionItem[];
  activity?: ActivityEvent[];
  history?: DashboardHistory;
  /** Operator-declared media pool (PLA-275); null/undefined when not configured. */
  mediaPool?: string | null;
}

const JELLYFIN_UNAVAILABLE: JellyfinSnapshot = {
  serverAvailable: false,
  version: null,
  sessions: [],
  lastPlaybackAt: null,
};

/**
 * Priority ordering for a correlated acquisition — the state the user most needs
 * to see wins when the same download is reported differently by two services
 * (e.g. qB "stalled" + Servarr "downloading" → stalled; Servarr "importing" + qB
 * "completed" → importing). Also drives display ordering.
 */
const STATE_PRIORITY: AcquisitionState[] = [
  "failed",
  "stalled",
  "importing",
  "downloading",
  "searching",
  "completed",
];

function pickState(states: AcquisitionState[]): AcquisitionState {
  let best: AcquisitionState = "completed";
  let bestIdx = STATE_PRIORITY.length;
  for (const s of states) {
    const i = STATE_PRIORITY.indexOf(s);
    if (i >= 0 && i < bestIdx) {
      bestIdx = i;
      best = s;
    }
  }
  return best;
}

/**
 * Merge a group of items that share an opaque correlation key (the same
 * infohash) into ONE acquisition item. Servarr is the authority for human media
 * identity (title/quality/import state); qBittorrent is the authority for live
 * transfer telemetry (rate/ETA/progress/stall). Only exact-identifier groups
 * reach here — there is deliberately no fuzzy title matching.
 */
function mergeCorrelatedGroup(key: string, group: AcquisitionItem[]): AcquisitionItem {
  const servarr = group.find((i) => i.source === "sonarr" || i.source === "radarr");
  const qb = group.find((i) => i.source === "qbittorrent");
  const identity = servarr ?? qb ?? group[0]!;
  const telemetry = qb ?? servarr ?? group[0]!;
  return {
    id: `acq-${key}`,
    source: identity.source,
    title: identity.title,
    quality: identity.quality ?? qb?.quality ?? null,
    state: pickState(group.map((i) => i.state)),
    progress: telemetry.progress,
    rateBps: qb?.rateBps ?? servarr?.rateBps ?? null,
    etaSeconds: qb?.etaSeconds ?? servarr?.etaSeconds ?? null,
    correlationKey: key,
  };
}

/**
 * Collapse items that represent the SAME acquisition across services into a
 * single coherent row, keyed on the opaque correlation key. Every keyed item
 * receives the canonical acquisition id even when it is the only source
 * currently reporting; source membership may change between polls, but the
 * underlying acquisition identity must not. Keyless items pass through
 * unchanged, and an identifier mismatch keeps two items separate.
 */
export function correlateAcquisition(items: AcquisitionItem[]): AcquisitionItem[] {
  const groups = new Map<string, AcquisitionItem[]>();
  const singles: AcquisitionItem[] = [];
  for (const it of items) {
    if (it.correlationKey) {
      const g = groups.get(it.correlationKey) ?? [];
      g.push(it);
      groups.set(it.correlationKey, g);
    } else {
      singles.push(it);
    }
  }
  const merged: AcquisitionItem[] = [];
  for (const [key, group] of groups) {
    merged.push(mergeCorrelatedGroup(key, group));
  }
  return [...merged, ...singles];
}

function rollupOf(items: AcquisitionItem[], aggregateRateBps: number): AcquisitionSnapshot["rollup"] {
  return {
    downloading: items.filter((i) => i.state === "downloading").length,
    importing: items.filter((i) => i.state === "importing").length,
    failedOrStalled: items.filter(
      (i) => i.state === "stalled" || i.state === "failed",
    ).length,
    aggregateRateBps: Math.max(0, Math.round(aggregateRateBps)),
  };
}

export function mergeAcquisition(
  sonarr: AcquisitionItem[] | null,
  radarr: AcquisitionItem[] | null,
  qbittorrent: AcquisitionSnapshot | null,
): AcquisitionSnapshot {
  const items = correlateAcquisition([
    ...(sonarr ?? []),
    ...(radarr ?? []),
    ...(qbittorrent?.items ?? []),
  ]);

  // qBittorrent's global download speed is the authoritative live throughput;
  // fall back to summing per-item rates for the *arr-only case.
  const summedRates = items.reduce((sum, i) => sum + (i.rateBps ?? 0), 0);
  const aggregateRateBps = qbittorrent?.rollup.aggregateRateBps ?? summedRates;

  return { items, rollup: rollupOf(items, aggregateRateBps) };
}

/**
 * Project the correlated acquisition set to the *browser-facing* view: drop the
 * seeding/completed library (that belongs in the activity history, not a
 * permanent list of every torrent) and order by what most needs attention. The
 * rollup is preserved — completed items never contributed to its counts. Kept
 * separate from `mergeAcquisition` so the full set (including completions) is
 * still available for server-side event derivation.
 */
export function filterAcquisitionForDisplay(
  acq: AcquisitionSnapshot,
): AcquisitionSnapshot {
  const items = acq.items
    .filter((i) => i.state !== "completed")
    .sort(
      (a, b) => STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state),
    );
  return { items, rollup: acq.rollup };
}

export function assembleSnapshot(parts: AggregateParts): DashboardSnapshot {
  return {
    mode: "live",
    generatedAt: parts.now,
    health: parts.health,
    jellyfin: parts.jellyfin ?? JELLYFIN_UNAVAILABLE,
    acquisition: mergeAcquisition(parts.sonarr, parts.radarr, parts.qbittorrent),
    zfs: parts.zfs ?? { pools: [] },
    telemetry:
      parts.telemetry ??
      (parts.telemetryNotConfigured ? notConfiguredTelemetry() : emptyTelemetry()),
    telemetryHistory: parts.telemetryHistory,
    attention: parts.attention ?? [],
    activity: parts.activity ?? [],
    history: parts.history,
    mediaPool: parts.mediaPool ?? null,
  };
}
