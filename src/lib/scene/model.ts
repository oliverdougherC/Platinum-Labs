/**
 * Scene model (PLA-266 rebuild) — normalized VISUAL entities derived from the
 * DashboardSnapshot. Pure and fixture-testable.
 *
 * The renderer never reads the snapshot directly: semantic state (health,
 * thresholds, staleness, activity) is resolved HERE, using the same shared
 * config as the attention engine, so visual state can never drift from alert
 * logic (PLA-266 review blocker). No pixels in this file — geometry belongs to
 * the layout engine.
 */

import { appConfig } from "@/lib/config";
import { isConnectorStale } from "@/lib/types";
import { deriveFlows, mediaStorageEndpoint } from "@/lib/topology/activity";
import type { FlowState } from "@/lib/topology/activity";
import type { DashboardSnapshot, ZfsPool } from "@/lib/types";

export type ServiceId = "jellyfin" | "sonarr" | "radarr" | "qbittorrent" | "seerr";

/**
 * Visual health of a body. `neutral` is for surfaces whose runtime health
 * cannot be established (e.g. Seerr, an interactive-only integration): shown
 * configured-but-unproven, never healthy green (PLA-266 review blocker).
 */
export type BodyStatus =
  | "ok"
  | "degraded"
  | "down"
  | "not-configured"
  | "neutral";

export interface ServiceBodyModel {
  id: ServiceId;
  label: string;
  status: BodyStatus;
  /** True when the service is doing real work right now. */
  active: boolean;
  /** Small count shown on hover/secondary label (sessions, queue items). */
  count: number | null;
  /** One-word activity detail ("streaming", "transcoding"), if any. */
  detail: string | null;
}

export type CapacityTone = "ok" | "warn" | "critical";

export interface StorageBodyModel {
  name: string;
  /** 0..1 headline (logical) occupancy. */
  capacityFraction: number;
  capacityTone: CapacityTone;
  /** Semantic size rank for layout: 0 = largest/most important. */
  rank: number;
  healthy: boolean;
  healthLabel: string;
  scrubbing: boolean;
  lastScrubAt: number | null;
  scrubErrors: number;
  readBps: number;
  writeBps: number;
  capacityLabelBytes: { used: number; total: number };
  capacityBasis: ZfsPool["capacityBasis"];
}

export interface CoreModel {
  hostname: string;
  status: "available" | "stale" | "unavailable" | "not-configured";
  /** 0..1 per logical CPU — real core count, never padded. */
  perCore: number[];
  totalFraction: number | null;
  load1: number | null;
  /** 0..1 memory occupancy, null when unknown. */
  memFraction: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  /** 0..1 swap occupancy when meaningful, else null. */
  swapFraction: number | null;
}

export interface NetworkModel {
  status: "available" | "stale" | "unavailable" | "not-configured";
  rxBps: number | null;
  txBps: number | null;
}

export interface DockerDotModel {
  name: string;
  /** Unhealthy or not running. */
  bad: boolean;
}

export interface DockerModel {
  status: "available" | "stale" | "unavailable" | "not-configured";
  dots: DockerDotModel[];
  running: number | null;
  total: number | null;
  unhealthy: number | null;
}

export interface SceneModel {
  core: CoreModel;
  services: ServiceBodyModel[];
  storage: StorageBodyModel[];
  /** True when media flows end at a generic storage endpoint (no declared pool). */
  genericStorageTarget: boolean;
  network: NetworkModel;
  docker: DockerModel;
  flows: FlowState[];
  /** Highest active severity, for the tiny critical edge affordance. */
  critical: boolean;
}

export interface SceneModelOptions {
  /** Whether Seerr/Requests is configured (search available). */
  seerrConfigured: boolean;
  now: number;
}

export const SERVICE_LABELS: Record<ServiceId, string> = {
  jellyfin: "Jellyfin",
  sonarr: "Sonarr",
  radarr: "Radarr",
  qbittorrent: "qBittorrent",
  seerr: "Requests",
};

export function capacityTone(fraction: number): CapacityTone {
  const { storageWarnFraction, storageCriticalFraction } = appConfig.thresholds;
  if (fraction >= storageCriticalFraction) return "critical";
  if (fraction >= storageWarnFraction) return "warn";
  return "ok";
}

function serviceStatus(
  snapshot: DashboardSnapshot,
  id: Exclude<ServiceId, "seerr">,
  now: number,
): BodyStatus {
  const h = snapshot.health.find((x) => x.id === id);
  if (!h || !h.configured) return "not-configured";
  if (h.status === "unavailable") return "down";
  if (h.status === "degraded" || isConnectorStale(h, now)) return "degraded";
  return "ok";
}

function serviceModel(
  snapshot: DashboardSnapshot,
  id: ServiceId,
  opts: SceneModelOptions,
): ServiceBodyModel {
  const label = SERVICE_LABELS[id];
  if (id === "seerr") {
    // Interactive-only integration: no polled health exists, so its state is
    // configured/neutral or not-configured — NEVER inferred healthy.
    return {
      id,
      label,
      status: opts.seerrConfigured ? "neutral" : "not-configured",
      active: false,
      count: null,
      detail: null,
    };
  }
  const status = serviceStatus(snapshot, id, opts.now);
  if (id === "jellyfin") {
    const sessions = snapshot.jellyfin.sessions;
    const transcoding = sessions.some((s) => s.method === "transcode");
    return {
      id,
      label,
      status,
      active: sessions.length > 0 && status === "ok",
      count: sessions.length > 0 ? sessions.length : null,
      detail:
        sessions.length > 0 ? (transcoding ? "transcoding" : "streaming") : null,
    };
  }
  if (id === "qbittorrent") {
    const r = snapshot.acquisition.rollup;
    const n = r.downloading + r.failedOrStalled;
    return {
      id,
      label,
      status,
      active: r.downloading > 0 && status === "ok",
      count: n > 0 ? n : null,
      detail: null,
    };
  }
  // sonarr / radarr
  const items = snapshot.acquisition.items.filter(
    (i) => i.source === id && i.state !== "completed",
  );
  return {
    id,
    label,
    status,
    active:
      status === "ok" &&
      items.some((i) => i.state === "downloading" || i.state === "importing"),
    count: items.length > 0 ? items.length : null,
    detail: items.some((i) => i.state === "importing") ? "importing" : null,
  };
}

/** Larger logical capacity ⇒ lower rank, but the order is semantic, not literal. */
function rankPools(pools: ZfsPool[]): Map<string, number> {
  const order = [...pools].sort((a, b) => b.totalBytes - a.totalBytes);
  return new Map(order.map((p, i) => [p.name, i]));
}

export function buildSceneModel(
  snapshot: DashboardSnapshot,
  opts: SceneModelOptions,
): SceneModel {
  const { now } = opts;
  const t = snapshot.telemetry;

  const perCore = t.cpu.value?.perCore ?? [];
  const mem = t.memory.value;
  const memFraction =
    mem && mem.totalBytes > 0 ? mem.usedBytes / mem.totalBytes : null;
  const swapFraction =
    mem && mem.swapTotalBytes !== null && mem.swapUsedBytes !== null && mem.swapTotalBytes > 0
      ? mem.swapUsedBytes / mem.swapTotalBytes
      : null;

  const core: CoreModel = {
    hostname: "p910",
    status: t.cpu.status,
    perCore,
    totalFraction: t.cpu.value?.totalFraction ?? null,
    load1: t.cpu.value?.load1 ?? null,
    memFraction,
    memUsedBytes: mem?.usedBytes ?? null,
    memTotalBytes: mem?.totalBytes ?? null,
    swapFraction: swapFraction !== null && swapFraction > 0.05 ? swapFraction : null,
  };

  const ranks = rankPools(snapshot.zfs.pools);
  const ioByPool = new Map(
    (t.disk.status === "available" || t.disk.status === "stale"
      ? t.disk.value?.pools ?? []
      : []
    ).map((p) => [p.pool, p]),
  );
  const storage: StorageBodyModel[] = snapshot.zfs.pools.map((pool) => {
    const io = ioByPool.get(pool.name);
    return {
      name: pool.name,
      capacityFraction: pool.capacityFraction,
      capacityTone: capacityTone(pool.capacityFraction),
      rank: ranks.get(pool.name) ?? 0,
      healthy: pool.health === "ONLINE",
      healthLabel: pool.health,
      scrubbing: pool.scan === "scrubbing" || pool.scan === "resilvering",
      lastScrubAt: pool.lastScrubAt,
      scrubErrors: pool.scrubErrors,
      readBps: io?.readBps ?? 0,
      writeBps: io?.writeBps ?? 0,
      capacityLabelBytes: { used: pool.usedBytes, total: pool.totalBytes },
      capacityBasis: pool.capacityBasis,
    };
  });

  const docker: DockerModel = {
    status: t.docker.status,
    dots: (t.docker.value?.containers ?? []).slice(0, 64).map((c) => ({
      name: c.name,
      bad: c.health === "unhealthy" || c.state !== "running",
    })),
    running: t.docker.value?.running ?? null,
    total: t.docker.value?.total ?? null,
    unhealthy: t.docker.value?.unhealthy ?? null,
  };

  const services = (
    ["jellyfin", "seerr", "sonarr", "radarr", "qbittorrent"] as const
  ).map((id) => serviceModel(snapshot, id, opts));

  return {
    core,
    services,
    storage,
    genericStorageTarget: mediaStorageEndpoint(snapshot).kind === "storage",
    network: {
      status: t.network.status,
      rxBps: t.network.value?.rxBps ?? null,
      txBps: t.network.value?.txBps ?? null,
    },
    docker,
    flows: deriveFlows(snapshot, now),
    critical: snapshot.attention.some((a) => a.severity === "critical"),
  };
}
