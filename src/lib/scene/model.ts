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
import {
  deriveFlows,
  downloadStorageEndpoint,
  mediaStorageEndpoint,
} from "@/lib/topology/activity";
import type { FlowObservation } from "@/lib/topology/activity";
import type { ContainerState, DashboardSnapshot, ZfsPool } from "@/lib/types";

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

/**
 * Freshness of a pool's I/O observation. `live` values may animate; `stale`
 * values may only render frozen state; `unavailable` means UNKNOWN — the body
 * must stay quiet, and unknown must never be drawn as a confirmed zero.
 */
export type IoFreshness = "live" | "stale" | "unavailable";

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
  /** Per-pool I/O rates; null when telemetry does not cover this pool. */
  readBps: number | null;
  writeBps: number | null;
  ioFreshness: IoFreshness;
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
  /** 0..1 GPU utilization when measured, else null (never fabricated). */
  gpuFraction: number | null;
}

export interface NetworkModel {
  status: "available" | "stale" | "unavailable" | "not-configured";
  rxBps: number | null;
  txBps: number | null;
  linkBytesPerSecond: number | null;
}

/**
 * How much of a container's metric set was actually observed this cycle.
 * `complete`: every metric carries a confirmed value (zeros included);
 * `partial`: some metrics observed, others null (e.g. cgroup v2 hosts omit
 * blkio); `unavailable`: nothing was sampled — a stats-collection skip or a
 * refresh-budget pass. Null metrics must never be rendered as CONFIRMED idle:
 * an unknown workload and a proven-quiet one are different truths (PLA-273).
 */
export type ContainerMetricCoverage = "complete" | "partial" | "unavailable";

export interface DockerContainerModel {
  name: string;
  state: ContainerState;
  health: "healthy" | "unhealthy" | "starting" | null;
  restartCount: number | null;
  cpuFraction: number | null;
  memoryBytes: number | null;
  memoryScore: number;
  netRxBps: number | null;
  netTxBps: number | null;
  blockReadBps: number | null;
  blockWriteBps: number | null;
  freshness: "live" | "stale" | "unavailable";
  serviceAssociation: ServiceId | null;
  resourceScore: number;
  radius: number;
  ioIntensity: number;
  /** Live work (CPU + I/O) driving motion energy; memory never contributes. */
  workScore: number;
  metricCoverage: ContainerMetricCoverage;
  unverified: boolean;
  bad: boolean;
}

export interface DockerModel {
  status: "available" | "stale" | "unavailable" | "not-configured";
  containers: DockerContainerModel[];
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
  /** Declared media pool name when it names a real pool, else null. */
  mediaPoolName: string | null;
  /** Declared download/staging pool name when it names a real pool, else null. */
  downloadPoolName: string | null;
  network: NetworkModel;
  docker: DockerModel;
  flows: FlowObservation[];
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

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Absolute memory pressure score with a soft logarithmic 64 MiB→8 GiB range. */
export function containerMemoryScore(bytes: number | null): number {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return 0;
  const unit = 64 * 1024 ** 2;
  return clamp01(Math.log1p(bytes / unit) / Math.log1p((8 * 1024 ** 3) / unit));
}

/** Bounded nonlinear workload score; unknown metrics remain quiet, never fake zero. */
export function containerResourceScore(
  cpuFraction: number | null,
  memoryBytes: number | null,
): number {
  const cpu = cpuFraction === null || !Number.isFinite(cpuFraction)
    ? 0
    : clamp01(1 - Math.exp(-Math.max(0, cpuFraction) / 0.7));
  const memory = containerMemoryScore(memoryBytes);
  return clamp01(Math.max(cpu, memory) * 0.72 + Math.min(cpu, memory) * 0.28);
}

/**
 * Live WORK signal for motion energy: CPU activity and network/block I/O
 * only — NEVER memory residency. A big-but-idle process (CPU 0, no I/O,
 * gigabytes resident) must sit perfectly still; residency may size the body
 * (resourceScore/radius) but motion is an activity claim (V2.1 motion-truth
 * blocker). Null metrics contribute nothing — unknown is quiet, not moving.
 */
export function containerWorkScore(
  cpuFraction: number | null,
  ioIntensity: number,
): number {
  const cpu = cpuFraction === null || !Number.isFinite(cpuFraction)
    ? 0
    : clamp01(1 - Math.exp(-Math.max(0, cpuFraction) / 0.7));
  return clamp01(Math.max(cpu, ioIntensity));
}

export function containerRadius(resourceScore: number): number {
  // Quiet workloads stay physically small; genuinely hot containers still
  // approach the 13-unit ceiling without letting modest memory residency turn
  // every idle process into a primary body.
  return 3 + 10 * Math.pow(clamp01(resourceScore), 1.15);
}

/** Classify observed vs missing metrics; see ContainerMetricCoverage. */
export function containerMetricCoverage(container: {
  cpuFraction: number | null;
  memoryBytes: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  blockReadBps: number | null;
  blockWriteBps: number | null;
}): ContainerMetricCoverage {
  const metrics = [
    container.cpuFraction,
    container.memoryBytes,
    container.netRxBps,
    container.netTxBps,
    container.blockReadBps,
    container.blockWriteBps,
  ];
  const known = metrics.filter((value) => value !== null).length;
  if (known === 0) return "unavailable";
  if (known === metrics.length) return "complete";
  return "partial";
}

export function containerIoIntensity(rates: Array<number | null>): number {
  const total = rates.reduce<number>((sum, rate) => sum + Math.max(0, rate ?? 0), 0);
  if (total <= 0) return 0;
  const floor = 64_000;
  const ceiling = 200_000_000;
  return clamp01(
    (Math.log10(Math.max(floor, total)) - Math.log10(floor)) /
      (Math.log10(ceiling) - Math.log10(floor)),
  );
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
    // Paused sessions are real sessions (kept in the count and drawer) but
    // they are not live work: they must not glow, and they must read
    // "paused", never "streaming"/"transcoding" (V2.1 pause-truth blocker).
    const playing = sessions.filter((s) => !s.paused);
    const pausedCount = sessions.length - playing.length;
    const transcoding = playing.some((s) => s.method === "transcode");
    const playingWord = transcoding ? "transcoding" : "streaming";
    return {
      id,
      label,
      status,
      active: playing.length > 0 && status === "ok",
      count: sessions.length > 0 ? sessions.length : null,
      detail:
        sessions.length === 0
          ? null
          : playing.length === 0
            ? "paused"
            : pausedCount > 0
              ? `${playingWord} · ${pausedCount} paused`
              : playingWord,
    };
  }
  if (id === "qbittorrent") {
    const r = snapshot.acquisition.rollup;
    const downloading = r.downloading > 0;
    const seeding = (r.seeding ?? 0) > 0;
    return {
      id,
      label,
      status,
      active: status === "ok" && (downloading || seeding),
      count:
        downloading && seeding
          ? null
          : downloading
            ? r.downloading
            : seeding
              ? (r.seeding ?? 0)
              : null,
      detail:
        downloading && seeding
          ? `downloading ${r.downloading} · seeding ${r.seeding ?? 0}`
          : downloading
            ? "downloading"
            : seeding
              ? "seeding"
              : null,
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
    hostname: snapshot.hostLabel?.trim() || "host",
    status: t.cpu.status,
    perCore,
    totalFraction: t.cpu.value?.totalFraction ?? null,
    load1: t.cpu.value?.load1 ?? null,
    memFraction,
    memUsedBytes: mem?.usedBytes ?? null,
    memTotalBytes: mem?.totalBytes ?? null,
    swapFraction: swapFraction !== null && swapFraction > 0.05 ? swapFraction : null,
    gpuFraction:
      t.gpu.status === "available" ? t.gpu.value?.utilizationFraction ?? null : null,
  };

  const ranks = rankPools(snapshot.zfs.pools);
  // Per-pool I/O with explicit freshness (PLA-273 hard rule): `stale` disk
  // telemetry keeps its last values but must never animate; `unavailable` /
  // `not-configured` yields null rates — unknown, NOT zero. A pool missing
  // from an otherwise-fresh sample is likewise unknown, not idle.
  const diskUsable = t.disk.status === "available" || t.disk.status === "stale";
  const ioByPool = new Map(
    (diskUsable ? t.disk.value?.pools ?? [] : []).map((p) => [p.pool, p]),
  );
  const storage: StorageBodyModel[] = snapshot.zfs.pools.map((pool) => {
    const io = ioByPool.get(pool.name);
    const ioFreshness: StorageBodyModel["ioFreshness"] = !diskUsable || !io
      ? "unavailable"
      : t.disk.status === "stale"
        ? "stale"
        : "live";
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
      readBps: io?.readBps ?? null,
      writeBps: io?.writeBps ?? null,
      ioFreshness,
      capacityLabelBytes: { used: pool.usedBytes, total: pool.totalBytes },
      capacityBasis: pool.capacityBasis,
    };
  });

  const docker: DockerModel = {
    status: t.docker.status,
    containers: (t.docker.value?.containers ?? []).map((c) => {
      const resourceScore = containerResourceScore(c.cpuFraction, c.memoryBytes);
      const ioIntensity = containerIoIntensity([
        c.netRxBps,
        c.netTxBps,
        c.blockReadBps,
        c.blockWriteBps,
      ]);
      return {
        ...c,
        memoryScore: containerMemoryScore(c.memoryBytes),
        freshness:
          t.docker.status === "available"
            ? "live" as const
            : t.docker.status === "stale"
              ? "stale" as const
              : "unavailable" as const,
        serviceAssociation:
          snapshot.jellyfinContainer === c.name ? "jellyfin" as const : null,
        resourceScore,
        radius: containerRadius(resourceScore),
        ioIntensity,
        workScore: containerWorkScore(c.cpuFraction, ioIntensity),
        metricCoverage: containerMetricCoverage(c),
        unverified: c.state === "unknown",
        bad:
          c.health === "unhealthy" ||
          (c.state !== "running" && c.state !== "unknown"),
      };
    }),
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
    genericStorageTarget:
      mediaStorageEndpoint(snapshot).kind === "storage" ||
      downloadStorageEndpoint(snapshot).kind === "storage",
    mediaPoolName: (() => {
      const e = mediaStorageEndpoint(snapshot);
      return e.kind === "pool" ? e.name : null;
    })(),
    downloadPoolName: (() => {
      const e = downloadStorageEndpoint(snapshot);
      return e.kind === "pool" ? e.name : null;
    })(),
    network: {
      status: t.network.status,
      rxBps: t.network.value?.rxBps ?? null,
      txBps: t.network.value?.txBps ?? null,
      linkBytesPerSecond: snapshot.networkLinkBytesPerSecond ?? null,
    },
    docker,
    flows: deriveFlows(snapshot, now),
    critical: snapshot.attention.some((a) => a.severity === "critical"),
  };
}
