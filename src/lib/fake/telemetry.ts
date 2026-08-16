/**
 * Deterministic fake host telemetry (PLA-265, fake mode + screenshots).
 *
 * Produces a full `HostTelemetrySnapshot` from a named profile and a clock.
 * Values are smooth functions of `now` (no randomness): the demo topology
 * breathes when polled continuously, yet any fixed `now` renders an identical
 * frame — the property the screenshot harness (PLA-270) depends on.
 *
 * The simulated machine mirrors the real p910 host: 32 logical CPUs, 126 GiB
 * RAM, a GTX 1070, three pools (DataStore / NVME / eSATA).
 */

import { clamp } from "@/lib/utils";
import {
  emptyTelemetryHistory,
  HISTORY_CAP,
  pushBounded,
} from "@/lib/telemetry/history";
import {
  emptyTelemetry,
  notConfiguredTelemetry,
} from "@/lib/telemetry/normalize";
import type {
  DockerContainerTelemetry,
  HostTelemetrySnapshot,
  TelemetryDomain,
  TelemetryHistory,
} from "@/lib/types";

export const FAKE_CORE_COUNT = 32;
const GiB = 1024 ** 3;
const MEM_TOTAL = 126 * GiB;
const SWAP_TOTAL = 64 * GiB;

export type TelemetryProfileName =
  | "idle"
  | "playback"
  | "transcode"
  | "downloads"
  | "seeding"
  | "importing"
  | "active"
  | "container-mixed"
  | "container-field-real"
  | "container-field-stress"
  | "busy"
  | "unavailable"
  | "unconfigured";

interface Profile {
  /** Mean total CPU fraction. */
  cpu: number;
  /** How many cores carry elevated load (rest stay near idle). */
  hotCores: number;
  memFraction: number;
  gpuUtil: number;
  netRxBps: number;
  netTxBps: number;
  /** Per-pool read/write rates in bytes/sec. */
  poolIo: Record<string, { read: number; write: number }>;
  jellyfinNetTxBps?: number;
  jellyfinBlockReadBps?: number;
  unhealthyContainers?: string[];
  unknownContainers?: string[];
  /** Explicit population override (real-scale / stress fixtures). */
  containerSpecs?: ContainerSpec[];
}

/**
 * One declared container for the real-scale fixtures. Everything is explicit
 * so the population's CPU/memory/network/block-I/O distribution, health mix,
 * and metric-coverage gaps are reviewable at a glance. `cpu` is the mean
 * fraction of one core (waves modulate around it); null metric fields stay
 * null — the stats-not-sampled path (PLA-273).
 */
interface ContainerSpec {
  name: string;
  state?: DockerContainerTelemetry["state"];
  health?: DockerContainerTelemetry["health"];
  restarts?: number | null;
  cpu: number | null;
  memGiB: number | null;
  netKBps?: [rx: number, tx: number] | null;
  blockKBps?: [read: number, write: number] | null;
}

/**
 * Sanitized replay of a real ~44-container homelab population (PLA-272): the
 * media stack plus the infra/apps a server this size actually runs. Names are
 * generic service names — nothing private. The distribution is the point:
 *  - a few genuinely hot workloads (transcode, photo ML, database)
 *  - a working middle band
 *  - a long idle tail (most of a real field is near-zero)
 *  - unhealthy + exited + unknown-state entries
 *  - several containers with NO sampled stats and some with partial coverage
 */
const REAL_FIELD_CONTAINERS: ContainerSpec[] = [
  // Hot band
  { name: "jellyfin", cpu: 1.9, memGiB: 3.2, netKBps: [400, 39_000], blockKBps: [42_000, 120] },
  { name: "immich-machine-learning", cpu: 1.4, memGiB: 4.1, netKBps: [220, 60], blockKBps: [900, 350] },
  { name: "postgres-immich", cpu: 0.8, memGiB: 1.9, netKBps: [180, 140], blockKBps: [2_400, 5_200] },
  { name: "qbittorrent", cpu: 0.6, memGiB: 1.4, netKBps: [34_000, 2_500], blockKBps: [3_000, 46_000] },
  // Working middle band
  { name: "immich-server", cpu: 0.35, memGiB: 1.1, netKBps: [900, 700], blockKBps: [600, 400] },
  { name: "sonarr", cpu: 0.22, memGiB: 0.8, netKBps: [120, 90], blockKBps: [300, 200] },
  { name: "radarr", cpu: 0.2, memGiB: 0.75, netKBps: [110, 85], blockKBps: [280, 190] },
  { name: "prowlarr", cpu: 0.12, memGiB: 0.4, netKBps: [60, 45], blockKBps: [40, 30] },
  { name: "platinum-homepage", cpu: 0.1, memGiB: 0.5, netKBps: [80, 220], blockKBps: [20, 60] },
  { name: "home-assistant", cpu: 0.18, memGiB: 1.2, netKBps: [140, 90], blockKBps: [90, 260] },
  { name: "frigate", cpu: 0.45, memGiB: 2.6, netKBps: [8_500, 300], blockKBps: [200, 9_800] },
  { name: "grafana", cpu: 0.08, memGiB: 0.45, netKBps: [70, 160], blockKBps: [30, 40] },
  { name: "prometheus", cpu: 0.14, memGiB: 1.6, netKBps: [260, 120], blockKBps: [180, 2_100] },
  { name: "loki", cpu: 0.09, memGiB: 0.9, netKBps: [340, 60], blockKBps: [70, 1_400] },
  { name: "paperless-ngx", cpu: 0.07, memGiB: 0.8, netKBps: [40, 35], blockKBps: [110, 90] },
  { name: "nextcloud", cpu: 0.11, memGiB: 1.0, netKBps: [420, 380], blockKBps: [340, 280] },
  { name: "postgres-nextcloud", cpu: 0.09, memGiB: 0.7, netKBps: [90, 70], blockKBps: [600, 900] },
  { name: "jellyseerr", cpu: 0.05, memGiB: 0.5, netKBps: [50, 40], blockKBps: [20, 15] },
  // Idle tail (confirmed-quiet: real zeros and near-zeros, full coverage)
  { name: "traefik", cpu: 0.03, memGiB: 0.25, netKBps: [700, 700], blockKBps: [5, 10] },
  { name: "authentik-server", cpu: 0.04, memGiB: 0.9, netKBps: [60, 55], blockKBps: [10, 25] },
  { name: "authentik-worker", cpu: 0.02, memGiB: 0.6, netKBps: [15, 10], blockKBps: [5, 15] },
  { name: "pihole", cpu: 0.02, memGiB: 0.15, netKBps: [90, 60], blockKBps: [2, 8] },
  { name: "unifi-controller", cpu: 0.06, memGiB: 1.3, netKBps: [130, 110], blockKBps: [30, 120] },
  { name: "gluetun", cpu: 0.03, memGiB: 0.1, netKBps: [34_500, 2_600], blockKBps: [0, 0] },
  { name: "bazarr", cpu: 0.02, memGiB: 0.35, netKBps: [20, 15], blockKBps: [15, 10] },
  { name: "tautulli", cpu: 0.02, memGiB: 0.3, netKBps: [25, 20], blockKBps: [10, 12] },
  { name: "dozzle", cpu: 0.01, memGiB: 0.12, netKBps: [30, 45], blockKBps: [0, 0] },
  { name: "dockge", cpu: 0.01, memGiB: 0.18, netKBps: [10, 12], blockKBps: [0, 2] },
  { name: "duplicati", cpu: 0.02, memGiB: 0.4, netKBps: [8, 6], blockKBps: [45, 30] },
  { name: "syncthing", cpu: 0.03, memGiB: 0.3, netKBps: [180, 160], blockKBps: [140, 120] },
  { name: "vaultwarden", cpu: 0.01, memGiB: 0.1, netKBps: [6, 5], blockKBps: [1, 3] },
  { name: "uptime-kuma", cpu: 0.02, memGiB: 0.2, netKBps: [40, 30], blockKBps: [2, 6] },
  { name: "redis-immich", cpu: 0.02, memGiB: 0.3, netKBps: [70, 60], blockKBps: [0, 40] },
  { name: "redis-paperless", cpu: 0.01, memGiB: 0.15, netKBps: [12, 10], blockKBps: [0, 8] },
  { name: "mariadb-homeassistant", cpu: 0.05, memGiB: 0.6, netKBps: [45, 35], blockKBps: [220, 480] },
  { name: "watchtower", cpu: 0, memGiB: 0.08, netKBps: [0, 0], blockKBps: [0, 0] },
  // Partial coverage: cpu/mem sampled, I/O counters unavailable (cgroup v2 blkio gap)
  { name: "homarr", cpu: 0.02, memGiB: 0.25, netKBps: [18, 22], blockKBps: null },
  { name: "wizarr", cpu: 0.01, memGiB: 0.2, netKBps: null, blockKBps: null },
  // No sampled stats at all: collector refresh-budget skips (state known only)
  { name: "cadvisor", cpu: null, memGiB: null, netKBps: null, blockKBps: null },
  { name: "node-exporter", cpu: null, memGiB: null, netKBps: null, blockKBps: null },
  { name: "smokeping", cpu: null, memGiB: null, netKBps: null, blockKBps: null },
  // Attention states
  { name: "flaresolverr", state: "exited", health: "unhealthy", restarts: 3, cpu: null, memGiB: null, netKBps: null, blockKBps: null },
  { name: "recyclarr", state: "exited", health: null, restarts: 0, cpu: null, memGiB: null, netKBps: null, blockKBps: null },
  { name: "unpackerr", state: "unknown", health: null, restarts: null, cpu: null, memGiB: null, netKBps: null, blockKBps: null },
];

/** Population size assertions live in tests and the screenshot harness. */
export const REAL_FIELD_CONTAINER_COUNT = REAL_FIELD_CONTAINERS.length;

/**
 * Stress fixture just above the 96-body render budget (PLA-272): the full
 * real-scale field plus a generated batch-worker fleet with a deterministic
 * activity spread, so 96 bodies render and a truthful overflow count remains.
 * Two of the batch workers are deliberately unhealthy/unknown AND sort last
 * alphabetically — proving priority selection keeps them out of the overflow.
 */
const STRESS_EXTRA_COUNT = 60;
const STRESS_FIELD_CONTAINERS: ContainerSpec[] = [
  ...REAL_FIELD_CONTAINERS,
  ...Array.from({ length: STRESS_EXTRA_COUNT }, (_, i): ContainerSpec => {
    const tier = i % 10;
    return {
      name: `worker-${String(i + 1).padStart(2, "0")}`,
      // 1 hot, 2 mid, 5 idle, 2 stats-skipped per ten workers.
      cpu: tier === 0 ? 0.9 : tier <= 2 ? 0.2 : tier <= 7 ? 0.02 : null,
      memGiB: tier >= 8 ? null : 0.2 + tier * 0.15,
      netKBps: tier >= 8 ? null : [20 * (tier + 1), 15 * (tier + 1)],
      blockKBps: tier >= 8 ? null : [10 * (tier + 1), 8 * (tier + 1)],
    };
  }),
  { name: "zz-batch-failed", state: "exited", health: "unhealthy", restarts: 5, cpu: null, memGiB: null, netKBps: null, blockKBps: null },
  { name: "zz-batch-unknown", state: "unknown", health: null, restarts: null, cpu: null, memGiB: null, netKBps: null, blockKBps: null },
];

export const STRESS_FIELD_CONTAINER_COUNT = STRESS_FIELD_CONTAINERS.length;

/** Materialize a spec list into deterministic breathing telemetry. */
function containersFromSpecs(
  specs: ContainerSpec[],
  now: number,
): DockerContainerTelemetry[] {
  return specs.map((spec, i) => ({
    name: spec.name,
    state: spec.state ?? "running",
    health: spec.health !== undefined ? spec.health : i % 4 === 0 ? "healthy" : null,
    restartCount: spec.restarts !== undefined ? spec.restarts : 0,
    cpuFraction:
      spec.cpu === null ? null : clamp(spec.cpu * (0.7 + 0.6 * wave(now, 45_000, i)), 0, 4),
    memoryBytes: spec.memGiB === null ? null : Math.round(spec.memGiB * GiB),
    netRxBps: spec.netKBps == null ? null : Math.round(spec.netKBps[0] * 1_000 * (0.8 + 0.4 * wave(now, 21_000, i))),
    netTxBps: spec.netKBps == null ? null : Math.round(spec.netKBps[1] * 1_000 * (0.8 + 0.4 * wave(now, 23_000, i + 7))),
    blockReadBps: spec.blockKBps == null ? null : Math.round(spec.blockKBps[0] * 1_000 * (0.8 + 0.4 * wave(now, 17_000, i + 3))),
    blockWriteBps: spec.blockKBps == null ? null : Math.round(spec.blockKBps[1] * 1_000 * (0.8 + 0.4 * wave(now, 19_000, i + 11))),
  }));
}

const PROFILES: Record<Exclude<TelemetryProfileName, "unavailable" | "unconfigured">, Profile> = {
  idle: {
    cpu: 0.06,
    hotCores: 2,
    memFraction: 0.38,
    gpuUtil: 0,
    netRxBps: 40_000,
    netTxBps: 25_000,
    poolIo: { NVME: { read: 300_000, write: 150_000 } },
  },
  playback: {
    cpu: 0.09,
    hotCores: 3,
    memFraction: 0.4,
    gpuUtil: 0.04,
    netRxBps: 90_000,
    netTxBps: 39_000_000,
    poolIo: {
      DataStore: { read: 42_000_000, write: 0 },
      NVME: { read: 500_000, write: 200_000 },
    },
    jellyfinNetTxBps: 39_000_000,
    jellyfinBlockReadBps: 42_000_000,
  },
  transcode: {
    cpu: 0.34,
    hotCores: 10,
    memFraction: 0.45,
    gpuUtil: 0.62,
    netRxBps: 120_000,
    netTxBps: 12_000_000,
    poolIo: {
      DataStore: { read: 55_000_000, write: 0 },
      NVME: { read: 800_000, write: 6_000_000 },
    },
    jellyfinNetTxBps: 12_000_000,
    jellyfinBlockReadBps: 55_000_000,
  },
  // The fake universe stages downloads on NVME (HOMELAB_DOWNLOAD_POOL) and
  // keeps the library on DataStore (HOMELAB_MEDIA_POOL): downloads write the
  // staging pool, imports copy staging → library (a real cross-pool copy).
  downloads: {
    cpu: 0.17,
    hotCores: 6,
    memFraction: 0.43,
    gpuUtil: 0,
    netRxBps: 34_000_000,
    netTxBps: 2_500_000,
    poolIo: {
      NVME: { read: 3_000_000, write: 46_000_000 },
      DataStore: { read: 1_000_000, write: 24_000_000 },
    },
  },
  seeding: {
    cpu: 0.14,
    hotCores: 5,
    memFraction: 0.43,
    gpuUtil: 0,
    netRxBps: 30_000_000,
    netTxBps: 12_000_000,
    poolIo: {
      NVME: { read: 7_000_000, write: 40_000_000 },
    },
  },
  importing: {
    cpu: 0.12,
    hotCores: 4,
    memFraction: 0.42,
    gpuUtil: 0,
    netRxBps: 300_000,
    netTxBps: 180_000,
    poolIo: {
      NVME: { read: 32_000_000, write: 500_000 },
      DataStore: { read: 800_000, write: 30_000_000 },
    },
  },
  active: {
    cpu: 0.21,
    hotCores: 8,
    memFraction: 0.47,
    gpuUtil: 0.05,
    netRxBps: 34_000_000,
    netTxBps: 39_000_000,
    poolIo: {
      DataStore: { read: 42_000_000, write: 24_000_000 },
      NVME: { read: 3_000_000, write: 46_000_000 },
    },
    jellyfinNetTxBps: 12_000_000,
    jellyfinBlockReadBps: 42_000_000,
  },
  "container-mixed": {
    cpu: 0.48,
    hotCores: 18,
    memFraction: 0.58,
    gpuUtil: 0.35,
    netRxBps: 44_000_000,
    netTxBps: 31_000_000,
    poolIo: {
      DataStore: { read: 58_000_000, write: 36_000_000 },
      NVME: { read: 12_000_000, write: 48_000_000 },
    },
    jellyfinNetTxBps: 31_000_000,
    jellyfinBlockReadBps: 58_000_000,
    unhealthyContainers: ["flaresolverr"],
    unknownContainers: ["unpackerr"],
  },
  busy: {
    cpu: 0.55,
    hotCores: 24,
    memFraction: 0.62,
    gpuUtil: 0.78,
    netRxBps: 46_000_000,
    netTxBps: 41_000_000,
    poolIo: {
      DataStore: { read: 60_000_000, write: 52_000_000 },
      NVME: { read: 9_000_000, write: 11_000_000 },
      eSATA: { read: 0, write: 22_000_000 },
    },
  },
  "container-field-real": {
    cpu: 0.28,
    hotCores: 12,
    memFraction: 0.55,
    gpuUtil: 0.3,
    netRxBps: 36_000_000,
    netTxBps: 40_000_000,
    poolIo: {
      DataStore: { read: 44_000_000, write: 12_000_000 },
      NVME: { read: 6_000_000, write: 18_000_000 },
    },
    jellyfinNetTxBps: 39_000_000,
    jellyfinBlockReadBps: 42_000_000,
    containerSpecs: REAL_FIELD_CONTAINERS,
  },
  "container-field-stress": {
    cpu: 0.5,
    hotCores: 20,
    memFraction: 0.66,
    gpuUtil: 0.4,
    netRxBps: 42_000_000,
    netTxBps: 41_000_000,
    poolIo: {
      DataStore: { read: 52_000_000, write: 30_000_000 },
      NVME: { read: 10_000_000, write: 34_000_000 },
    },
    jellyfinNetTxBps: 39_000_000,
    jellyfinBlockReadBps: 42_000_000,
    containerSpecs: STRESS_FIELD_CONTAINERS,
  },
};

/** Smooth deterministic 0..1 oscillation — distinct phase per seed. */
function wave(now: number, periodMs: number, seed: number): number {
  return 0.5 + 0.5 * Math.sin(now / periodMs + seed * 2.399963);
}

function available<T>(value: T, now: number): TelemetryDomain<T> {
  return { status: "available", value, updatedAt: now };
}

const FAKE_CONTAINERS = [
  "platinum-homepage",
  "jellyfin",
  "sonarr",
  "radarr",
  "qbittorrent",
  "prowlarr",
  "jellyseerr",
  "gluetun",
  "unpackerr",
  "flaresolverr",
  "grafana",
  "prometheus",
  "dozzle",
  "dockge",
];

function fakeContainers(
  now: number,
  profile: Profile,
): DockerContainerTelemetry[] {
  if (profile.containerSpecs) return containersFromSpecs(profile.containerSpecs, now);
  const unhealthy = new Set(profile.unhealthyContainers ?? []);
  const unknown = new Set(profile.unknownContainers ?? []);
  return FAKE_CONTAINERS.map((name, i) => {
    const bad = unhealthy.has(name);
    const unverified = unknown.has(name);
    return {
      name,
      state: bad ? "exited" : unverified ? "unknown" : "running",
      health: bad ? "unhealthy" : unverified ? null : i % 3 === 0 ? "healthy" : null,
      restartCount: bad ? 3 : unverified ? null : 0,
      cpuFraction: bad || unverified
        ? null
        : clamp(0.01 + 0.2 * profile.cpu * wave(now, 45_000, i), 0, 2),
      memoryBytes: bad || unverified ? null : Math.round((0.2 + (i % 5) * 0.35) * GiB),
      // A few containers deliberately report unknown I/O so the null path
      // stays exercised in fake mode (unknown ≠ zero, PLA-273).
      netRxBps: bad || unverified || i % 4 === 3 ? null : Math.round(20_000 * (1 + (i % 3))),
      netTxBps:
        name === "jellyfin" && profile.jellyfinNetTxBps !== undefined
          ? profile.jellyfinNetTxBps
          : bad || unverified || i % 4 === 3
            ? null
            : Math.round(12_000 * (1 + (i % 3))),
      blockReadBps:
        name === "jellyfin" && profile.jellyfinBlockReadBps !== undefined
          ? profile.jellyfinBlockReadBps
          : bad || unverified || i % 5 === 4
            ? null
            : Math.round(80_000 * (1 + (i % 2))),
      blockWriteBps: bad || unverified || i % 5 === 4 ? null : Math.round(45_000 * (1 + (i % 2))),
    };
  });
}

/** Build one deterministic telemetry snapshot for a profile at a given time. */
export function makeFakeTelemetry(
  name: TelemetryProfileName,
  now: number,
): HostTelemetrySnapshot {
  if (name === "unavailable") return emptyTelemetry();
  if (name === "unconfigured") return notConfiguredTelemetry();
  const profile = PROFILES[name];

  const perCore: number[] = [];
  for (let core = 0; core < FAKE_CORE_COUNT; core++) {
    // Scatter hot cores around the ring (real schedulers do not fill cores in
    // order, and a contiguous hot cluster makes the corona lopsided).
    const hot = (core * 7) % FAKE_CORE_COUNT < profile.hotCores;
    const base = hot ? profile.cpu * 1.9 : profile.cpu * 0.35;
    const wobble = wave(now, 18_000 + core * 700, core);
    perCore.push(clamp(base * (0.55 + 0.9 * wobble), 0.004, 0.98));
  }
  const totalFraction = clamp(
    perCore.reduce((a, b) => a + b, 0) / FAKE_CORE_COUNT,
    0,
    1,
  );

  const containers = fakeContainers(now, profile);
  const breathing = wave(now, 60_000, 7);

  return {
    cpu: available(
      {
        totalFraction,
        perCore,
        load1: Number((totalFraction * FAKE_CORE_COUNT * 0.9).toFixed(2)),
        load5: Number((totalFraction * FAKE_CORE_COUNT * 0.8).toFixed(2)),
        load15: Number((totalFraction * FAKE_CORE_COUNT * 0.7).toFixed(2)),
      },
      now,
    ),
    memory: available(
      {
        totalBytes: MEM_TOTAL,
        usedBytes: Math.round(MEM_TOTAL * (profile.memFraction + 0.02 * breathing)),
        availableBytes: Math.round(
          MEM_TOTAL * (1 - profile.memFraction - 0.02 * breathing),
        ),
        swapTotalBytes: SWAP_TOTAL,
        swapUsedBytes: Math.round(0.004 * SWAP_TOTAL),
      },
      now,
    ),
    gpu: available(
      {
        name: "NVIDIA GeForce GTX 1070",
        utilizationFraction: clamp(
          profile.gpuUtil * (0.8 + 0.4 * wave(now, 23_000, 3)),
          0,
          1,
        ),
        vramUsedBytes: Math.round((0.01 + 0.5 * profile.gpuUtil) * 8 * GiB),
        vramTotalBytes: 8 * GiB,
        temperatureC: Math.round(38 + 30 * profile.gpuUtil),
        powerWatts: Math.round(10 + 140 * profile.gpuUtil),
      },
      now,
    ),
    network: available(
      {
        rxBps: profile.netRxBps * (0.75 + 0.5 * wave(now, 21_000, 11)),
        txBps: profile.netTxBps * (0.75 + 0.5 * wave(now, 27_000, 13)),
        interfaces: ["eno1"],
      },
      now,
    ),
    disk: available(
      {
        readBps: Object.values(profile.poolIo).reduce((a, io) => a + io.read, 0),
        writeBps: Object.values(profile.poolIo).reduce((a, io) => a + io.write, 0),
        pools: Object.entries(profile.poolIo).map(([pool, io], i) => ({
          pool,
          readBps: io.read * (0.7 + 0.6 * wave(now, 17_000, 17 + i)),
          writeBps: io.write * (0.7 + 0.6 * wave(now, 19_000, 23 + i)),
        })),
      },
      now,
    ),
    docker: available(
      {
        total: containers.length,
        running: containers.filter((c) => c.state === "running").length,
        healthy: containers.filter((c) => c.health === "healthy").length,
        unhealthy: containers.filter((c) => c.health === "unhealthy").length,
        restarting: 0,
        containers,
      },
      now,
    ),
    arc: available(
      {
        sizeBytes: Math.round(38 * GiB + 4 * GiB * breathing),
        targetBytes: 60 * GiB,
        hitRatio: 0.96,
      },
      now,
    ),
  };
}

/** Deterministic bounded history leading up to `now` (2s cadence). */
export function makeFakeTelemetryHistory(
  name: TelemetryProfileName,
  now: number,
): TelemetryHistory {
  const history = emptyTelemetryHistory();
  if (name === "unavailable" || name === "unconfigured") return history;
  const stepMs = 2_000;
  for (let i = HISTORY_CAP - 1; i >= 0; i--) {
    const t = now - i * stepMs;
    const snap = makeFakeTelemetry(name, t);
    if (snap.cpu.value) {
      pushBounded(history.cpuTotal, { t, v: snap.cpu.value.totalFraction });
    }
    if (snap.network.value) {
      pushBounded(history.netRx, { t, v: snap.network.value.rxBps });
      pushBounded(history.netTx, { t, v: snap.network.value.txBps });
    }
    if (snap.disk.value) {
      pushBounded(history.diskRead, { t, v: snap.disk.value.readBps });
      pushBounded(history.diskWrite, { t, v: snap.disk.value.writeBps });
    }
  }
  return history;
}
