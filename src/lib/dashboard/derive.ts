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

/** Connectors that make up the media system surface. */
export const MEDIA_CONNECTORS: ConnectorId[] = [
  "jellyfin",
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

/** Visual state for the media module. */
export function mediaVisualState(snapshot: DashboardSnapshot): VisualState {
  if (hasAttentionFrom(snapshot, MEDIA_CONNECTORS)) return "attention";

  const jf = healthById(snapshot.health, "jellyfin");
  if (jf && jf.configured && jf.status === "unavailable") return "attention";

  const { rollup } = snapshot.acquisition;
  const busy =
    snapshot.jellyfin.sessions.length > 0 ||
    rollup.downloading > 0 ||
    rollup.importing > 0;
  return busy ? "active" : "ambient";
}

/** Visual state for the storage module. */
export function storageVisualState(snapshot: DashboardSnapshot): VisualState {
  if (snapshot.zfs.pools.some((p) => p.health !== "ONLINE")) return "attention";
  if (hasAttentionFrom(snapshot, ["zfs"])) return "attention";
  return "ambient";
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
