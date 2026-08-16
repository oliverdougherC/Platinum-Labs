/**
 * Pure derivation helpers for the dashboard composition (PLA-175).
 *
 * These translate a normalized snapshot into the visual-state decisions the
 * layout needs — which module is ambient/active/attention, and how each
 * connector should present (ok / stale / unavailable / not-configured). Kept
 * pure and isomorphic so the progressive-disclosure logic is unit-tested
 * independently of rendering.
 */

import type { VisualState } from "@/lib/design/tokens";
import {
  isConnectorStale,
  type ConnectorHealth,
  type ConnectorId,
  type DashboardSnapshot,
} from "@/lib/types";

/** Connectors that feed the acquisition queue. */
export const ACQUISITION_CONNECTORS: ConnectorId[] = [
  "sonarr",
  "radarr",
  "qbittorrent",
];

export function healthById(
  health: ConnectorHealth[],
  id: ConnectorId,
): ConnectorHealth | undefined {
  return health.find((h) => h.id === id);
}

/** How a single connector should be presented in the UI. */
export type ConnectorPresentation =
  | "ok"
  | "stale"
  | "unavailable"
  | "unconfigured"
  | "misconfigured";

export function connectorPresentation(
  health: ConnectorHealth | undefined,
  now: number,
): ConnectorPresentation {
  if (!health) return "unconfigured";
  // A half-configured connector is a distinct, actionable state — never conflate
  // it with a clean "not set up" or a runtime failure.
  if (health.configError) return "misconfigured";
  if (!health.configured) return "unconfigured";
  if (health.status === "unavailable") return "unavailable";
  if (health.status !== "healthy" || isConnectorStale(health, now)) {
    return "stale";
  }
  return "ok";
}

/** True when the snapshot has at least one attention item from `source`. */
export function hasAttentionFrom(
  snapshot: DashboardSnapshot,
  sources: ConnectorId[],
): boolean {
  const set = new Set(sources);
  return snapshot.attention.some((a) => set.has(a.source));
}

/** Visual state for the storage module. */
export function storageVisualState(snapshot: DashboardSnapshot): VisualState {
  if (snapshot.zfs.pools.some((p) => p.health !== "ONLINE")) return "attention";
  if (hasAttentionFrom(snapshot, ["zfs"])) return "attention";
  return "ambient";
}

/**
 * Truthful empty-state for the acquisition surface (PLA-194). Distinguishes a
 * genuinely clear queue from an unavailable/incomplete one so `items.length===0`
 * never silently reads as "clear" when a source is actually down.
 */
export type AcquisitionAvailability =
  | { kind: "clear"; stale: boolean } // ≥1 configured source, none down; queue truly empty
  | { kind: "degraded" } // a configured source is unavailable/misconfigured → may be incomplete
  | { kind: "unconfigured" }; // no acquisition source configured at all

export function acquisitionAvailability(
  snapshot: DashboardSnapshot,
  now: number,
): AcquisitionAvailability {
  const pres = ACQUISITION_CONNECTORS.map((id) =>
    connectorPresentation(healthById(snapshot.health, id), now),
  );
  const configured = pres.filter((p) => p !== "unconfigured");
  if (configured.length === 0) return { kind: "unconfigured" };
  if (configured.some((p) => p === "unavailable" || p === "misconfigured")) {
    return { kind: "degraded" };
  }
  return { kind: "clear", stale: configured.some((p) => p === "stale") };
}

/**
 * How the storage surface should present its (possibly empty) pool set (PLA-194).
 * A configured-but-unavailable ZFS source must never read as "not configured".
 */
export type StoragePresentation =
  | "ok" // healthy; render pools (or a truthful empty set)
  | "stale" // serving last-known-good; render pools with a freshness hint
  | "unavailable" // configured but currently unreachable
  | "unconfigured" // no ZFS source configured
  | "misconfigured"; // half-configured (e.g. token without URL)

export function storagePresentation(
  snapshot: DashboardSnapshot,
  now: number,
): StoragePresentation {
  return connectorPresentation(healthById(snapshot.health, "zfs"), now);
}

/** Capacity band for a pool, used for tone selection (never color-only). */
export type CapacityBand = "ok" | "warning" | "critical";

export function capacityBand(
  fraction: number,
  warn = 0.8,
  critical = 0.9,
): CapacityBand {
  if (fraction >= critical) return "critical";
  if (fraction >= warn) return "warning";
  return "ok";
}
