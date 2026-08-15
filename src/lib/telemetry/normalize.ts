/**
 * Host telemetry normalization (PLA-265) — pure, fixture-testable.
 *
 * The collector sidecar reports RAW CUMULATIVE COUNTERS (CPU jiffies, interface
 * byte totals, disk sector bytes, container CPU ns). This module turns two
 * successive raw samples into one normalized `HostTelemetrySnapshot` with
 * per-domain availability. Rules:
 *
 *  - a domain the collector marked "unavailable"/"not-configured" is reported
 *    exactly that way — NEVER as zeros;
 *  - rate domains (cpu, network, disk) need two samples; with only one they are
 *    `unavailable` (value null), not zero;
 *  - a counter that went backwards (reboot/reset) invalidates that delta — the
 *    domain keeps its previous value and is marked stale for the tick.
 */

import { z } from "zod";
import { clamp } from "@/lib/utils";
import type {
  ArcTelemetry,
  ContainerState,
  CpuTelemetry,
  DiskIoTelemetry,
  DockerTelemetry,
  GpuTelemetry,
  HostTelemetrySnapshot,
  MemoryTelemetry,
  NetworkTelemetry,
  TelemetryDomain,
} from "@/lib/types";

// --- raw wire schema ---------------------------------------------------------

const sectionStatus = z.enum(["ok", "unavailable", "not-configured"]);

const rawCpuSchema = z.object({
  status: sectionStatus,
  total: z.array(z.number()).nullish(),
  cores: z.array(z.array(z.number())).nullish(),
  load: z.array(z.number()).nullish(),
});

const rawMemorySchema = z.object({
  status: sectionStatus,
  totalBytes: z.number().nullish(),
  availableBytes: z.number().nullish(),
  swapTotalBytes: z.number().nullish(),
  swapUsedBytes: z.number().nullish(),
});

const rawNetworkSchema = z.object({
  status: sectionStatus,
  interfaces: z
    .record(z.object({ rxBytes: z.number(), txBytes: z.number() }))
    .nullish(),
});

const rawDiskSchema = z.object({
  status: sectionStatus,
  devices: z
    .record(z.object({ readBytes: z.number(), writeBytes: z.number() }))
    .nullish(),
  poolDevices: z.record(z.array(z.string())).nullish(),
});

const rawGpuSchema = z.object({
  status: sectionStatus,
  name: z.string().nullish(),
  utilizationPercent: z.number().nullish(),
  vramUsedBytes: z.number().nullish(),
  vramTotalBytes: z.number().nullish(),
  temperatureC: z.number().nullish(),
  powerWatts: z.number().nullish(),
});

const rawContainerSchema = z.object({
  name: z.string(),
  state: z.string(),
  health: z.enum(["healthy", "unhealthy", "starting"]).nullish(),
  restartCount: z.number().nullish(),
  cpuTotalNs: z.number().nullish(),
  systemCpuNs: z.number().nullish(),
  memoryBytes: z.number().nullish(),
});

const rawDockerSchema = z.object({
  status: sectionStatus,
  containers: z.array(rawContainerSchema).nullish(),
});

const rawArcSchema = z.object({
  status: sectionStatus,
  sizeBytes: z.number().nullish(),
  targetBytes: z.number().nullish(),
  hits: z.number().nullish(),
  misses: z.number().nullish(),
});

export const hostCollectorSchema = z
  .object({
    sampledAt: z.number(),
    cpu: rawCpuSchema,
    memory: rawMemorySchema,
    network: rawNetworkSchema,
    disk: rawDiskSchema,
    gpu: rawGpuSchema,
    docker: rawDockerSchema,
    arc: rawArcSchema,
  })
  .passthrough();

export type RawHostSample = z.infer<typeof hostCollectorSchema>;

// --- helpers -----------------------------------------------------------------

function domain<T>(
  status: TelemetryDomain<T>["status"],
  value: T | null,
  updatedAt: number | null,
): TelemetryDomain<T> {
  return { status, value, updatedAt };
}

function unavailable<T>(): TelemetryDomain<T> {
  return domain<T>("unavailable", null, null);
}

function notConfigured<T>(): TelemetryDomain<T> {
  return domain<T>("not-configured", null, null);
}

/**
 * Hold the previous domain value, marked stale, when the current tick could
 * not produce a fresh one (counter reset, first sample). Falls back to
 * unavailable when there is nothing to hold.
 */
function holdStale<T>(prev: TelemetryDomain<T> | undefined): TelemetryDomain<T> {
  if (prev && prev.value !== null) {
    return domain("stale", prev.value, prev.updatedAt);
  }
  return unavailable<T>();
}

/** Busy fraction from two cumulative jiffy vectors [user..steal]. Null when the window is invalid. */
export function cpuFractionFromJiffies(
  prev: number[],
  curr: number[],
): number | null {
  if (prev.length < 4 || curr.length < 4) return null;
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const totalDelta = sum(curr) - sum(prev);
  if (totalDelta <= 0) return null;
  // idle + iowait are the non-busy columns (indexes 3 and 4).
  const idlePrev = prev[3]! + (prev[4] ?? 0);
  const idleCurr = curr[3]! + (curr[4] ?? 0);
  const idleDelta = idleCurr - idlePrev;
  return clamp((totalDelta - idleDelta) / totalDelta, 0, 1);
}

// --- normalization -----------------------------------------------------------

function normalizeCpu(
  prevRaw: RawHostSample | null,
  curr: RawHostSample,
  prevDomain: TelemetryDomain<CpuTelemetry> | undefined,
): TelemetryDomain<CpuTelemetry> {
  const raw = curr.cpu;
  if (raw.status !== "ok" || !raw.total || !raw.cores || !raw.load) {
    return raw.status === "not-configured" ? notConfigured() : unavailable();
  }
  const prev = prevRaw?.cpu;
  if (!prev || prev.status !== "ok" || !prev.total || !prev.cores) {
    return holdStale(prevDomain);
  }
  const totalFraction = cpuFractionFromJiffies(prev.total, raw.total);
  if (totalFraction === null) return holdStale(prevDomain);
  const perCore: number[] = [];
  for (let i = 0; i < raw.cores.length; i++) {
    const prevCore = prev.cores[i];
    const f = prevCore ? cpuFractionFromJiffies(prevCore, raw.cores[i]!) : null;
    // A single unreadable core invalidates the vector rather than faking 0.
    if (f === null) return holdStale(prevDomain);
    perCore.push(f);
  }
  return domain(
    "available",
    {
      totalFraction,
      perCore,
      load1: raw.load[0] ?? 0,
      load5: raw.load[1] ?? 0,
      load15: raw.load[2] ?? 0,
    },
    curr.sampledAt,
  );
}

function normalizeMemory(curr: RawHostSample): TelemetryDomain<MemoryTelemetry> {
  const raw = curr.memory;
  if (
    raw.status !== "ok" ||
    typeof raw.totalBytes !== "number" ||
    typeof raw.availableBytes !== "number"
  ) {
    return raw.status === "not-configured" ? notConfigured() : unavailable();
  }
  return domain(
    "available",
    {
      totalBytes: raw.totalBytes,
      availableBytes: raw.availableBytes,
      usedBytes: Math.max(0, raw.totalBytes - raw.availableBytes),
      swapTotalBytes: raw.swapTotalBytes ?? 0,
      swapUsedBytes: raw.swapUsedBytes ?? 0,
    },
    curr.sampledAt,
  );
}

function normalizeGpu(curr: RawHostSample): TelemetryDomain<GpuTelemetry> {
  const raw = curr.gpu;
  if (raw.status === "not-configured") return notConfigured();
  if (
    raw.status !== "ok" ||
    typeof raw.utilizationPercent !== "number" ||
    typeof raw.vramUsedBytes !== "number" ||
    typeof raw.vramTotalBytes !== "number"
  ) {
    return unavailable();
  }
  return domain(
    "available",
    {
      name: raw.name ?? "GPU",
      utilizationFraction: clamp(raw.utilizationPercent / 100, 0, 1),
      vramUsedBytes: raw.vramUsedBytes,
      vramTotalBytes: raw.vramTotalBytes,
      temperatureC: raw.temperatureC ?? null,
      powerWatts: raw.powerWatts ?? null,
    },
    curr.sampledAt,
  );
}

function rateBetween(
  prevBytes: number,
  currBytes: number,
  elapsedMs: number,
): number | null {
  if (elapsedMs <= 0) return null;
  const delta = currBytes - prevBytes;
  if (delta < 0) return null; // counter reset — invalid window
  return (delta / elapsedMs) * 1000;
}

function normalizeNetwork(
  prevRaw: RawHostSample | null,
  curr: RawHostSample,
  prevDomain: TelemetryDomain<NetworkTelemetry> | undefined,
): TelemetryDomain<NetworkTelemetry> {
  const raw = curr.network;
  if (raw.status !== "ok" || !raw.interfaces) {
    return raw.status === "not-configured" ? notConfigured() : unavailable();
  }
  const prev = prevRaw?.network;
  if (!prev || prev.status !== "ok" || !prev.interfaces) {
    return holdStale(prevDomain);
  }
  const elapsed = curr.sampledAt - prevRaw.sampledAt;
  let rx = 0;
  let tx = 0;
  const names: string[] = [];
  for (const [name, counters] of Object.entries(raw.interfaces)) {
    const before = prev.interfaces[name];
    if (!before) continue;
    const rxRate = rateBetween(before.rxBytes, counters.rxBytes, elapsed);
    const txRate = rateBetween(before.txBytes, counters.txBytes, elapsed);
    if (rxRate === null || txRate === null) return holdStale(prevDomain);
    rx += rxRate;
    tx += txRate;
    names.push(name);
  }
  if (names.length === 0) return holdStale(prevDomain);
  return domain("available", { rxBps: rx, txBps: tx, interfaces: names }, curr.sampledAt);
}

function normalizeDisk(
  prevRaw: RawHostSample | null,
  curr: RawHostSample,
  prevDomain: TelemetryDomain<DiskIoTelemetry> | undefined,
): TelemetryDomain<DiskIoTelemetry> {
  const raw = curr.disk;
  if (raw.status !== "ok" || !raw.devices) {
    return raw.status === "not-configured" ? notConfigured() : unavailable();
  }
  const prev = prevRaw?.disk;
  if (!prev || prev.status !== "ok" || !prev.devices) {
    return holdStale(prevDomain);
  }
  const elapsed = curr.sampledAt - prevRaw.sampledAt;
  const perDevice = new Map<string, { readBps: number; writeBps: number }>();
  for (const [name, counters] of Object.entries(raw.devices)) {
    const before = prev.devices[name];
    if (!before) continue;
    const readBps = rateBetween(before.readBytes, counters.readBytes, elapsed);
    const writeBps = rateBetween(before.writeBytes, counters.writeBytes, elapsed);
    if (readBps === null || writeBps === null) return holdStale(prevDomain);
    perDevice.set(name, { readBps, writeBps });
  }
  if (perDevice.size === 0) return holdStale(prevDomain);
  let readBps = 0;
  let writeBps = 0;
  for (const rates of perDevice.values()) {
    readBps += rates.readBps;
    writeBps += rates.writeBps;
  }
  const pools = [];
  const assigned = new Set<string>();
  for (const [pool, devices] of Object.entries(raw.poolDevices ?? {})) {
    let poolRead = 0;
    let poolWrite = 0;
    let any = false;
    for (const device of devices) {
      const rates = perDevice.get(device);
      if (!rates) continue;
      poolRead += rates.readBps;
      poolWrite += rates.writeBps;
      assigned.add(device);
      any = true;
    }
    if (any) pools.push({ pool, readBps: poolRead, writeBps: poolWrite });
  }
  let otherRead = 0;
  let otherWrite = 0;
  let hasOther = false;
  for (const [device, rates] of perDevice) {
    if (assigned.has(device)) continue;
    otherRead += rates.readBps;
    otherWrite += rates.writeBps;
    hasOther = true;
  }
  if (hasOther) pools.push({ pool: "other", readBps: otherRead, writeBps: otherWrite });
  return domain("available", { readBps, writeBps, pools }, curr.sampledAt);
}

const CONTAINER_STATES: ContainerState[] = [
  "running",
  "paused",
  "restarting",
  "exited",
  "dead",
  "created",
];

function normalizeDocker(
  prevRaw: RawHostSample | null,
  curr: RawHostSample,
): TelemetryDomain<DockerTelemetry> {
  const raw = curr.docker;
  if (raw.status === "not-configured") return notConfigured();
  if (raw.status !== "ok" || !raw.containers) return unavailable();
  const prevContainers = new Map(
    (prevRaw?.docker.containers ?? []).map((c) => [c.name, c]),
  );
  const coreCount =
    curr.cpu.status === "ok" && curr.cpu.cores ? curr.cpu.cores.length : null;
  const containers = raw.containers.map((c) => {
    const state = (CONTAINER_STATES as string[]).includes(c.state)
      ? (c.state as ContainerState)
      : "exited";
    let cpuFraction: number | null = null;
    const before = prevContainers.get(c.name);
    if (
      typeof c.cpuTotalNs === "number" &&
      typeof c.systemCpuNs === "number" &&
      typeof before?.cpuTotalNs === "number" &&
      typeof before?.systemCpuNs === "number"
    ) {
      const cpuDelta = c.cpuTotalNs - before.cpuTotalNs;
      const sysDelta = c.systemCpuNs - before.systemCpuNs;
      if (cpuDelta >= 0 && sysDelta > 0 && coreCount !== null) {
        // cpuDelta/sysDelta is the fraction of the whole host; scale to
        // "cores used" like `docker stats`.
        cpuFraction = clamp((cpuDelta / sysDelta) * coreCount, 0, coreCount);
      }
    }
    return {
      name: c.name,
      state,
      health: c.health ?? null,
      restartCount: c.restartCount ?? 0,
      cpuFraction,
      memoryBytes: typeof c.memoryBytes === "number" ? c.memoryBytes : null,
    };
  });
  return domain(
    "available",
    {
      total: containers.length,
      running: containers.filter((c) => c.state === "running").length,
      healthy: containers.filter((c) => c.health === "healthy").length,
      unhealthy: containers.filter((c) => c.health === "unhealthy").length,
      restarting: containers.filter((c) => c.state === "restarting").length,
      containers,
    },
    curr.sampledAt,
  );
}

function normalizeArc(curr: RawHostSample): TelemetryDomain<ArcTelemetry> {
  const raw = curr.arc;
  if (raw.status !== "ok" || typeof raw.sizeBytes !== "number") {
    return raw.status === "not-configured" ? notConfigured() : unavailable();
  }
  const hits = raw.hits ?? null;
  const misses = raw.misses ?? null;
  const lookups = hits !== null && misses !== null ? hits + misses : null;
  return domain(
    "available",
    {
      sizeBytes: raw.sizeBytes,
      targetBytes: raw.targetBytes ?? raw.sizeBytes,
      hitRatio: lookups && lookups > 0 ? clamp(hits! / lookups, 0, 1) : null,
    },
    curr.sampledAt,
  );
}

/**
 * Normalize one raw collector sample against the previous sample and the
 * previous normalized snapshot (for stale holds).
 */
export function normalizeHostTelemetry(
  prevRaw: RawHostSample | null,
  curr: RawHostSample,
  prevSnapshot?: HostTelemetrySnapshot | null,
): HostTelemetrySnapshot {
  return {
    cpu: normalizeCpu(prevRaw, curr, prevSnapshot?.cpu),
    memory: normalizeMemory(curr),
    gpu: normalizeGpu(curr),
    network: normalizeNetwork(prevRaw, curr, prevSnapshot?.network),
    disk: normalizeDisk(prevRaw, curr, prevSnapshot?.disk),
    docker: normalizeDocker(prevRaw, curr),
    arc: normalizeArc(curr),
  };
}

/** A snapshot in which every domain is unavailable (collector unreachable, no last-known-good). */
export function emptyTelemetry(): HostTelemetrySnapshot {
  return {
    cpu: unavailable(),
    memory: unavailable(),
    gpu: unavailable(),
    network: unavailable(),
    disk: unavailable(),
    docker: unavailable(),
    arc: unavailable(),
  };
}

/** A snapshot for deployments with no host collector configured at all. */
export function notConfiguredTelemetry(): HostTelemetrySnapshot {
  return {
    cpu: notConfigured(),
    memory: notConfigured(),
    gpu: notConfigured(),
    network: notConfigured(),
    disk: notConfigured(),
    docker: notConfigured(),
    arc: notConfigured(),
  };
}

/**
 * Re-grade `available` domains whose sample has aged past `staleAfterMs`
 * without losing the last-known-good value.
 */
export function gradeTelemetryFreshness(
  snapshot: HostTelemetrySnapshot,
  now: number,
  staleAfterMs: number,
): HostTelemetrySnapshot {
  const grade = <T>(d: TelemetryDomain<T>): TelemetryDomain<T> =>
    d.status === "available" &&
    d.updatedAt !== null &&
    now - d.updatedAt > staleAfterMs
      ? { ...d, status: "stale" }
      : d;
  return {
    cpu: grade(snapshot.cpu),
    memory: grade(snapshot.memory),
    gpu: grade(snapshot.gpu),
    network: grade(snapshot.network),
    disk: grade(snapshot.disk),
    docker: grade(snapshot.docker),
    arc: grade(snapshot.arc),
  };
}
