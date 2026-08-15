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
  | "active"
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
  unhealthyContainers?: string[];
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
  },
  downloads: {
    cpu: 0.17,
    hotCores: 6,
    memFraction: 0.43,
    gpuUtil: 0,
    netRxBps: 34_000_000,
    netTxBps: 2_500_000,
    poolIo: {
      DataStore: { read: 1_000_000, write: 48_000_000 },
      NVME: { read: 2_000_000, write: 14_000_000 },
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
      DataStore: { read: 42_000_000, write: 48_000_000 },
      NVME: { read: 2_500_000, write: 14_000_000 },
    },
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
  const unhealthy = new Set(profile.unhealthyContainers ?? []);
  return FAKE_CONTAINERS.map((name, i) => {
    const bad = unhealthy.has(name);
    return {
      name,
      state: bad ? "exited" : "running",
      health: bad ? "unhealthy" : i % 3 === 0 ? "healthy" : null,
      restartCount: bad ? 3 : 0,
      cpuFraction: bad
        ? null
        : clamp(0.01 + 0.2 * profile.cpu * wave(now, 45_000, i), 0, 2),
      memoryBytes: bad ? null : Math.round((0.2 + (i % 5) * 0.35) * GiB),
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
    const hot = core < profile.hotCores;
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
