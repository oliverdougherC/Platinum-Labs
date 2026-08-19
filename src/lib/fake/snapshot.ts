/**
 * Deterministic fake connector/state simulator (PLA-177).
 *
 * A reusable development fixture system: every scenario builds a full
 * `DashboardSnapshot` from the *same normalized types the real connectors use*,
 * with no randomness (given a fixed `now`, output is identical) so scenarios are
 * safe for automated tests and screenshots.
 *
 * Isomorphic and secret-free. This module performs no I/O — fake mode can never
 * accidentally reach a real service (asserted in tests).
 */

import { appConfig } from "@/lib/config";
import {
  storageTrendSeries,
  throughputSeries,
  type ActivityLevel,
} from "@/lib/fake/series";
import {
  makeFakeTelemetry,
  makeFakeTelemetryHistory,
  type TelemetryProfileName,
} from "@/lib/fake/telemetry";
import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  ActivityEvent,
  AttentionItem,
  ConnectorHealth,
  ConnectorId,
  ConnectorStatus,
  DashboardHistory,
  DashboardSnapshot,
  JellyfinSession,
  JellyfinSnapshot,
  ZfsPool,
  ZfsSnapshot,
} from "@/lib/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Decimal terabyte — storage fixtures use decimal semantics (PLA-264). */
const TB = 1e12;
const GB = 1e9;

const CONNECTOR_IDS: ConnectorId[] = [
  "jellyfin",
  "sonarr",
  "radarr",
  "qbittorrent",
  "zfs",
  "host",
];

// --- health helpers ---------------------------------------------------------

interface HealthOverride {
  status?: ConnectorStatus;
  configured?: boolean;
  lastSuccessAt?: number | null;
  lastError?: string | null;
}

function buildHealth(
  now: number,
  overrides: Partial<Record<ConnectorId, HealthOverride>> = {},
): ConnectorHealth[] {
  return CONNECTOR_IDS.map((id) => {
    const o = overrides[id] ?? {};
    const status: ConnectorStatus = o.status ?? "healthy";
    return {
      id,
      status,
      configured: o.configured ?? true,
      lastSuccessAt:
        o.lastSuccessAt !== undefined
          ? o.lastSuccessAt
          : status === "healthy"
            ? now - 5_000
            : now - 4 * MINUTE,
      lastError: o.lastError ?? (status === "healthy" ? null : "Request timed out"),
      configError: null,
      pollIntervalMs: appConfig.pollIntervalsMs[id],
    };
  });
}

// --- subsystem builders -----------------------------------------------------

function jellyfinIdle(now: number): JellyfinSnapshot {
  return {
    serverAvailable: true,
    version: "10.9.11",
    sessions: [],
    lastPlaybackAt: now - 3 * HOUR,
  };
}

function session(overrides: Partial<JellyfinSession> & { id: string }): JellyfinSession {
  return {
    user: "oliver",
    title: "Dune: Part Two",
    subtitle: null,
    method: "direct-play",
    paused: false,
    progress: 0.42,
    resolution: "4K",
    rate: {
      bytesPerSecond: 4_750_000,
      basis: "source-media",
      evidence: "reported",
    },
    ...overrides,
  };
}

function jellyfinUnavailable(): JellyfinSnapshot {
  return { serverAvailable: false, version: null, sessions: [], lastPlaybackAt: null };
}

function acquisitionEmpty(): AcquisitionSnapshot {
  return {
    items: [],
    rollup: {
      downloading: 0,
      importing: 0,
      failedOrStalled: 0,
      aggregateRateBps: 0,
      // The fake connector "measures" transfer counters, so idle upload is a
      // true zero here — unknown-upload cases are built explicitly in tests.
      uploadRateBps: 0,
      seeding: 0,
    },
  };
}

function rollup(
  items: AcquisitionItem[],
  upload: { uploadRateBps: number | null; seeding: number } = {
    uploadRateBps: 0,
    seeding: 0,
  },
): AcquisitionSnapshot["rollup"] {
  return {
    downloading: items.filter((i) => i.state === "downloading").length,
    importing: items.filter((i) => i.state === "importing").length,
    failedOrStalled: items.filter((i) => i.state === "stalled" || i.state === "failed")
      .length,
    aggregateRateBps: items.reduce((sum, i) => sum + (i.rateBps ?? 0), 0),
    uploadRateBps: upload.uploadRateBps,
    seeding: upload.seeding,
  };
}

function acquisitionActive(): AcquisitionSnapshot {
  const items: AcquisitionItem[] = [
    {
      id: "q-1",
      source: "sonarr",
      title: "Severance — S02E07",
      quality: "WEB-DL 1080p",
      state: "downloading",
      progress: 0.63,
      rateBps: 7_500_000,
      etaSeconds: 320,
    },
    {
      id: "q-2",
      source: "radarr",
      title: "Sinners (2025)",
      quality: "Bluray-2160p",
      state: "downloading",
      progress: 0.18,
      rateBps: 4_200_000,
      etaSeconds: 1_450,
    },
    {
      id: "q-3",
      source: "sonarr",
      title: "Shrinking — S02E10",
      quality: "WEB-DL 1080p",
      state: "importing",
      progress: 1,
      rateBps: null,
      etaSeconds: null,
    },
  ];
  return { items, rollup: rollup(items) };
}

/** Active queue ownership with a measured, honest zero transfer rate. */
function acquisitionConfirmedZero(): AcquisitionSnapshot {
  const items: AcquisitionItem[] = [
    {
      id: "q-zero",
      source: "sonarr",
      title: "Severance — S02E07",
      quality: "WEB-DL 1080p",
      state: "downloading",
      progress: 0.63,
      rateBps: 0,
      etaSeconds: null,
    },
  ];
  return { items, rollup: rollup(items) };
}

/** Simultaneous download + seed-upload (the bidirectional WAN conduit demo). */
function acquisitionSeeding(): AcquisitionSnapshot {
  const items: AcquisitionItem[] = [
    {
      id: "q-1",
      source: "sonarr",
      title: "Severance — S02E07",
      quality: "WEB-DL 1080p",
      state: "downloading",
      progress: 0.63,
      rateBps: 7_500_000,
      etaSeconds: 320,
    },
  ];
  return { items, rollup: rollup(items, { uploadRateBps: 5_800_000, seeding: 4 }) };
}

/** Seed-upload only: proves reverse-only WAN/storage flow semantics. */
function acquisitionSeedOnly(): AcquisitionSnapshot {
  return {
    items: [],
    rollup: rollup([], { uploadRateBps: 5_800_000, seeding: 4 }),
  };
}

/** Import-only queue: Sonarr organizing a finished download, nothing moving on the WAN. */
function acquisitionImporting(): AcquisitionSnapshot {
  const items: AcquisitionItem[] = [
    {
      id: "q-3",
      source: "sonarr",
      title: "Shrinking — S02E10",
      quality: "WEB-DL 1080p",
      state: "importing",
      progress: 1,
      rateBps: null,
      etaSeconds: null,
    },
  ];
  return { items, rollup: rollup(items) };
}

function acquisitionStalled(): AcquisitionSnapshot {
  const items: AcquisitionItem[] = [
    {
      id: "q-1",
      source: "sonarr",
      title: "Severance — S02E07",
      quality: "WEB-DL 1080p",
      state: "downloading",
      progress: 0.63,
      rateBps: 7_500_000,
      etaSeconds: 320,
    },
    {
      id: "q-2",
      source: "radarr",
      title: "Sinners (2025)",
      quality: "Bluray-2160p",
      state: "stalled",
      progress: 0.18,
      rateBps: 0,
      etaSeconds: null,
    },
    {
      id: "q-4",
      source: "qbittorrent",
      title: "ubuntu-24.04.2-live-server-amd64.iso",
      quality: null,
      state: "failed",
      progress: 0.04,
      rateBps: 0,
      etaSeconds: null,
    },
  ];
  return { items, rollup: rollup(items) };
}

interface PoolSpec {
  name: string;
  /** Logical root-dataset values (decimal-byte fixtures). */
  logicalUsed: number;
  logicalTotal: number;
  /** Physical zpool values. */
  physicalSize: number;
  physicalAlloc: number;
  fragPercent?: number;
  health?: ZfsPool["health"];
  scan?: ZfsPool["scan"];
  lastScrubAt?: number | null;
  scrubErrors?: number;
}

function pool(spec: PoolSpec): ZfsPool {
  const logical = {
    usedBytes: spec.logicalUsed,
    availBytes: spec.logicalTotal - spec.logicalUsed,
    totalBytes: spec.logicalTotal,
    usedFraction: spec.logicalTotal > 0 ? spec.logicalUsed / spec.logicalTotal : 0,
  };
  return {
    name: spec.name,
    usedBytes: logical.usedBytes,
    totalBytes: logical.totalBytes,
    capacityFraction: logical.usedFraction, // always derived, never drifts
    capacityBasis: "logical",
    allocation: {
      sizeBytes: spec.physicalSize,
      allocBytes: spec.physicalAlloc,
      freeBytes: spec.physicalSize - spec.physicalAlloc,
      capFraction: spec.physicalSize > 0 ? spec.physicalAlloc / spec.physicalSize : 0,
      fragPercent: spec.fragPercent ?? null,
    },
    logical,
    health: spec.health ?? "ONLINE",
    scan: spec.scan ?? "finished",
    lastScrubAt: spec.lastScrubAt ?? null,
    scrubErrors: spec.scrubErrors ?? 0,
  };
}

// Scrub timestamps floored to a day boundary so they stay STABLE across the
// many `now` values of a polling simulation (a drifting scrub time would make
// deriveEvents emit a spurious scrub event every poll).
function scrubDay(now: number, daysAgo: number): number {
  return Math.floor((now - daysAgo * DAY) / DAY) * DAY;
}

/**
 * The demo topology mirrors the audited p910 pools (PLA-264): DataStore
 * (4×24 TB RAIDZ1 — 96 TB raw / 69.6 TB logical), NVME (2×2 TB mirror),
 * eSATA (8×4 TB RAIDZ1 — 32 TB raw / 27.7 TB logical, empty).
 */
function nvmePool(now: number): ZfsPool {
  return pool({
    name: "NVME",
    logicalUsed: 365.6 * GB,
    logicalTotal: 1.931 * TB,
    physicalSize: 1.993 * TB,
    physicalAlloc: 347.7 * GB,
    fragPercent: 5,
    lastScrubAt: scrubDay(now, 7),
  });
}

function esataPool(now: number, overrides: Partial<PoolSpec> = {}): ZfsPool {
  return pool({
    name: "eSATA",
    logicalUsed: 0.5 * GB,
    logicalTotal: 27.68 * TB,
    physicalSize: 32.006 * TB,
    physicalAlloc: 0.6 * GB,
    fragPercent: 0,
    lastScrubAt: scrubDay(now, 7),
    ...overrides,
  });
}

function zfsHealthy(now: number): ZfsSnapshot {
  return {
    pools: [
      pool({
        name: "DataStore",
        logicalUsed: 41.8 * TB,
        logicalTotal: 69.6 * TB,
        physicalSize: 95.98 * TB,
        physicalAlloc: 57.6 * TB,
        fragPercent: 18,
        lastScrubAt: scrubDay(now, 3),
      }),
      nvmePool(now),
      esataPool(now),
    ],
  };
}

/** The audited live values: DataStore at 86.8% logical / 86% physical CAP. */
function zfsWarning(now: number): ZfsSnapshot {
  return {
    pools: [
      pool({
        name: "DataStore",
        logicalUsed: 60.406 * TB,
        logicalTotal: 69.601 * TB,
        physicalSize: 95.984 * TB,
        physicalAlloc: 83.139 * TB,
        fragPercent: 25,
        lastScrubAt: scrubDay(now, 3),
      }),
      nvmePool(now),
      esataPool(now),
    ],
  };
}

function zfsDegraded(now: number): ZfsSnapshot {
  return {
    pools: [
      pool({
        name: "DataStore",
        logicalUsed: 60.406 * TB,
        logicalTotal: 69.601 * TB,
        physicalSize: 95.984 * TB,
        physicalAlloc: 83.139 * TB,
        fragPercent: 25,
        lastScrubAt: scrubDay(now, 3),
      }),
      nvmePool(now),
      esataPool(now, {
        health: "DEGRADED",
        lastScrubAt: scrubDay(now, 20),
        scrubErrors: 4,
      }),
    ],
  };
}

function baseActivity(now: number): ActivityEvent[] {
  return [
    {
      id: "ev-2",
      at: now - 34 * MINUTE,
      kind: "media.imported",
      severity: "info",
      source: "radarr",
      message: "Imported Sinners (2025)",
    },
    {
      id: "ev-3",
      at: now - 6 * HOUR,
      kind: "zfs.scrub.completed",
      severity: "info",
      source: "zfs",
      message: "Scrub of DataStore completed with 0 errors",
    },
  ];
}

// --- scenario registry ------------------------------------------------------

export const SCENARIOS = [
  "idle",
  "direct-play",
  "transcode",
  "transcode-fallback",
  "transcode-unknown-rate",
  "direct-stream",
  "paused",
  "confirmed-zero",
  "multi-session",
  "mixed-session",
  "downloads",
  "seeding",
  "seed-only",
  "importing",
  "radarr-import",
  "same-pool-import",
  "cross-pool-import",
  "gpu-workload",
  "pool-scrub",
  "docker-unavailable",
  "relationship-map",
  "stalled",
  "connector-unavailable",
  "stale",
  "zfs-warning",
  "zfs-degraded",
  "unconfigured",
  // Composite aliases used by defaults and the attention path.
  "active",
  "attention",
  "container-mixed",
  // Real-scale container-field fixtures (PLA-272): a sanitized ~44-container
  // replay of a real server population, and a stress field just above the
  // 96-body render budget.
  "container-field-real",
  "container-field-stress",
] as const;

export type FakeScenario = (typeof SCENARIOS)[number];

export const DEFAULT_SCENARIO: FakeScenario = "active";

/** Type guard for untrusted input (query params, env). */
export function isScenario(value: unknown): value is FakeScenario {
  return typeof value === "string" && (SCENARIOS as readonly string[]).includes(value);
}

/** Human-readable labels for the dev scenario switcher. */
export const SCENARIO_LABELS: Record<FakeScenario, string> = {
  idle: "All healthy / idle",
  "direct-play": "Jellyfin — direct play",
  transcode: "Jellyfin — transcode",
  "transcode-fallback": "Jellyfin — measured fallback",
  "transcode-unknown-rate": "Jellyfin — playing, rate unknown",
  "direct-stream": "Jellyfin — direct stream (estimated)",
  paused: "Jellyfin — paused session",
  "confirmed-zero": "Active download — confirmed zero rate",
  "multi-session": "Multiple sessions",
  "mixed-session": "Mixed known / unknown sessions",
  downloads: "Active downloads / imports",
  seeding: "Download + seed upload",
  "seed-only": "Seed upload only",
  importing: "Sonarr import (organizing)",
  "radarr-import": "Radarr import",
  "same-pool-import": "Same-pool import (organizing)",
  "cross-pool-import": "Cross-pool import (copy)",
  "gpu-workload": "GPU-heavy workload",
  "pool-scrub": "DataStore scrub in progress",
  "docker-unavailable": "Docker inventory unavailable",
  "relationship-map": "Declared service relationships",
  stalled: "Stalled / failed transfer",
  "connector-unavailable": "Connector unavailable",
  stale: "Stale (last-known-good)",
  "zfs-warning": "ZFS near threshold",
  "zfs-degraded": "ZFS DEGRADED",
  unconfigured: "No connectors configured",
  active: "Active (playback + downloads)",
  attention: "Attention (stall + degraded)",
  "container-mixed": "Mixed container resources / health",
  "container-field-real": "Container field — real-scale (44)",
  "container-field-stress": "Container field — over budget",
};

type Builder = (now: number) => DashboardSnapshot;

function fakeHistory(
  now: number,
  acquisition: AcquisitionSnapshot,
  zfs: ZfsSnapshot,
): DashboardHistory {
  const rate = acquisition.rollup.aggregateRateBps;
  const level: ActivityLevel =
    rate !== null && rate > 20_000_000
      ? "high"
      : rate !== null && rate > 0
        ? "light"
        : "empty";

  const throughput = throughputSeries({ now, level }).map((p) => ({
    t: p.t,
    bps: p.bps,
  }));

  const pools = zfs.pools.map((p) => ({
    name: p.name,
    endBytes: p.usedBytes,
    totalBytes: p.totalBytes,
  }));
  const storage = storageTrendSeries({
    now,
    days: 30,
    pools,
    level: pools.length > 0 ? "light" : "empty",
  });

  return { throughput, storageSeries: pools.map((p) => p.name), storage };
}

function compose(
  now: number,
  parts: {
    health?: ConnectorHealth[];
    jellyfin: JellyfinSnapshot;
    acquisition: AcquisitionSnapshot;
    zfs: ZfsSnapshot;
    telemetryProfile?: TelemetryProfileName;
    attention?: AttentionItem[];
    activity?: ActivityEvent[];
  },
): DashboardSnapshot {
  const profile = parts.telemetryProfile ?? "idle";
  return {
    mode: "fake",
    generatedAt: now,
    hostLabel: "Host",
    health: parts.health ?? buildHealth(now),
    jellyfin: parts.jellyfin,
    acquisition: parts.acquisition,
    zfs: parts.zfs,
    telemetry: makeFakeTelemetry(profile, now),
    telemetryHistory: makeFakeTelemetryHistory(profile, now),
    attention: parts.attention ?? [],
    activity: parts.activity ?? baseActivity(now),
    history: fakeHistory(now, parts.acquisition, parts.zfs),
    // The fake universe declares its pools explicitly, mirroring the
    // HOMELAB_MEDIA_POOL / HOMELAB_DOWNLOAD_POOL contracts (PLA-275): media
    // lives on DataStore, downloads stage on NVME — so demo imports are real
    // cross-pool copies with an honest source and destination.
    mediaPool: "DataStore",
    downloadPool: "NVME",
    jellyfinContainer: "jellyfin",
    networkLinkBytesPerSecond: 1_250_000_000,
  };
}

const stalledAttention = (now: number): AttentionItem[] => [
  {
    ruleId: "qbittorrent.transfer.stalled",
    alertId: "qbittorrent.transfer.stalled:q-2",
    severity: "warning",
    title: "Transfer stalled",
    detail: "Sinners (2025) has been stalled for 18 minutes.",
    source: "qbittorrent",
    subject: "q-2",
    firstSeenAt: now - 18 * MINUTE,
    lastSeenAt: now,
  },
];

const degradedAttention = (now: number): AttentionItem[] => [
  {
    ruleId: "zfs.pool.degraded",
    alertId: "zfs.pool.degraded:eSATA",
    severity: "critical",
    title: "Pool degraded",
    detail: "Pool eSATA is DEGRADED.",
    source: "zfs",
    subject: "eSATA",
    firstSeenAt: now - 40 * MINUTE,
    lastSeenAt: now,
  },
];

const BUILDERS: Record<FakeScenario, Builder> = {
  idle: (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "idle",
    }),

  "direct-play": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - 2 * MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "playback",
    }),

  transcode: (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({
            id: "s1",
            title: "The Bear — S03E01",
            subtitle: "S03E01 — Tomorrow",
            method: "transcode",
            resolution: "1080p",
            rate: {
              bytesPerSecond: 1_500_000,
              basis: "jellyfin-session-output",
              evidence: "reported",
            },
            progress: 0.27,
          }),
        ],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "transcode",
    }),

  "transcode-fallback": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({
            id: "s1",
            title: "The Bear — S03E01",
            subtitle: "S03E01 — Tomorrow",
            method: "transcode",
            resolution: "1080p",
            // Mirrors the sanitized real /Sessions response where Jellyfin
            // omitted every session bitrate field. The explicitly mapped
            // container's measured egress is the truthful fallback.
            rate: {
              bytesPerSecond: 12_000_000,
              basis: "container-egress",
              evidence: "measured",
            },
            progress: 0.27,
          }),
        ],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "transcode",
    }),

  // A GENUINELY PLAYING transcode where neither the session nor the mapped
  // container yields any byte rate: the honest display is "rate unknown"
  // with a state-only breathing path — never a fabricated number, never a
  // confirmed zero, and never silently hidden work.
  "transcode-unknown-rate": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({
            id: "s1",
            title: "The Bear — S03E01",
            subtitle: "S03E01 — Tomorrow",
            method: "transcode",
            resolution: "1080p",
            rate: null,
            progress: 0.27,
          }),
        ],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "transcode-unknown",
    }),

  // A remux (direct stream): the only rate evidence is the SOURCE-media
  // bitrate, which is an ESTIMATE of the output — the visible convention
  // must carry the ≈ prefix (V2.1 evidence-display).
  "direct-stream": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({
            id: "s1",
            method: "direct-stream",
            rate: {
              bytesPerSecond: 4_750_000,
              basis: "source-media",
              evidence: "estimated",
            },
          }),
        ],
        lastPlaybackAt: now - 2 * MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "transcode-unknown",
    }),

  // Mirrors the committed sanitized real /Sessions case: a PAUSED transcode
  // with no output rate. The session stays listed (drawer reads "paused"),
  // but there is no playback/egress flow, no service glow, and no
  // session-derived rate — pause is reported state, not a zero-rate guess.
  paused: (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({
            id: "s1",
            title: "The Bear — S03E01",
            subtitle: "S03E01 — Tomorrow",
            method: "transcode",
            paused: true,
            resolution: "1080p",
            rate: null,
            progress: 0.27,
          }),
        ],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "idle",
    }),

  "confirmed-zero": (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionConfirmedZero(),
      zfs: zfsHealthy(now),
      telemetryProfile: "idle",
    }),

  "multi-session": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({ id: "s1", user: "oliver", method: "direct-play", progress: 0.42 }),
          session({
            id: "s2",
            user: "sam",
            title: "Andor — S02E04",
            subtitle: "S02E04 — Ever Been to Ghorman?",
            method: "transcode",
            resolution: "1080p",
            rate: {
              bytesPerSecond: 1_187_500,
              basis: "jellyfin-session-output",
              evidence: "reported",
            },
            progress: 0.71,
          }),
        ],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "transcode",
    }),

  "mixed-session": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [
          session({ id: "s1", user: "oliver", method: "direct-play", progress: 0.42 }),
          session({
            id: "s2",
            user: "sam",
            title: "Andor — S02E04",
            subtitle: "S02E04 — Ever Been to Ghorman?",
            method: "transcode",
            resolution: "1080p",
            rate: {
              bytesPerSecond: 1_187_500,
              basis: "jellyfin-session-output",
              evidence: "reported",
            },
            progress: 0.71,
          }),
          session({
            id: "s3",
            user: "guest",
            title: "Reservation Dogs — S03E10",
            subtitle: "S03E10 — Dig",
            method: "transcode",
            resolution: "720p",
            rate: null,
            progress: 0.18,
          }),
        ],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "transcode",
    }),

  downloads: (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "downloads",
    }),

  seeding: (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionSeeding(),
      zfs: zfsHealthy(now),
      telemetryProfile: "seeding",
    }),

  "seed-only": (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionSeedOnly(),
      zfs: zfsHealthy(now),
      telemetryProfile: "seeding",
    }),

  importing: (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionImporting(),
      zfs: zfsHealthy(now),
      telemetryProfile: "importing",
    }),

  "radarr-import": (now) => {
    const acquisition = acquisitionImporting();
    acquisition.items[0] = {
      ...acquisition.items[0]!,
      id: "q-radarr-import",
      source: "radarr",
      title: "Sinners (2025)",
      quality: "Bluray-2160p",
    };
    return compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition,
      zfs: zfsHealthy(now),
      telemetryProfile: "importing",
    });
  },

  "same-pool-import": (now) => {
    const snapshot = compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionImporting(),
      zfs: zfsHealthy(now),
      telemetryProfile: "same-pool-import",
    });
    snapshot.downloadPool = "DataStore";
    return snapshot;
  },

  "cross-pool-import": (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionImporting(),
      zfs: zfsHealthy(now),
      telemetryProfile: "importing",
    }),

  "gpu-workload": (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "gpu-workload",
    }),

  "pool-scrub": (now) => {
    const zfs = zfsHealthy(now);
    const dataStore = zfs.pools.find((item) => item.name === "DataStore");
    if (dataStore) dataStore.scan = "scrubbing";
    return compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionEmpty(),
      zfs,
      telemetryProfile: "idle",
    });
  },

  "docker-unavailable": (now) => {
    const snapshot = compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionEmpty(),
      zfs: zfsHealthy(now),
      telemetryProfile: "idle",
    });
    snapshot.telemetry.docker = { status: "unavailable", updatedAt: null, value: null };
    return snapshot;
  },

  "relationship-map": (now) => {
    const snapshot = compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - 2 * MINUTE,
      },
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "active",
    });
    snapshot.fabricRelationships = [
      { from: "service:seerr", to: "service:sonarr", kind: "dependency", label: "request routing" },
      { from: "service:seerr", to: "service:radarr", kind: "dependency", label: "request routing" },
      { from: "service:sonarr", to: "service:qbittorrent", kind: "control", label: "download client" },
      { from: "service:sonarr", to: "service:jellyfin", kind: "control", label: "library refresh" },
      { from: "host:control", to: "service:seerr", kind: "dependency", label: "operator control" },
    ];
    return snapshot;
  },

  stalled: (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionStalled(),
      zfs: zfsHealthy(now),
      telemetryProfile: "downloads",
      attention: stalledAttention(now),
      activity: [
        {
          id: "ev-f",
          at: now - 2 * MINUTE,
          kind: "transfer.failed",
          severity: "warning",
          source: "qbittorrent",
          message: "Transfer failed: ubuntu-24.04.2-live-server-amd64.iso",
        },
        ...baseActivity(now),
      ],
    }),

  "connector-unavailable": (now) =>
    compose(now, {
      health: buildHealth(now, {
        jellyfin: { status: "unavailable", lastError: "ECONNREFUSED", lastSuccessAt: now - 5 * MINUTE },
      }),
      jellyfin: jellyfinUnavailable(),
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "downloads",
      attention: [
        {
          ruleId: "connector.unavailable",
          alertId: "connector.unavailable:jellyfin",
          severity: "warning",
          title: "Jellyfin unreachable",
          detail: "Jellyfin has been unreachable for 5 minutes.",
          source: "jellyfin",
          subject: "jellyfin",
          firstSeenAt: now - 5 * MINUTE,
          lastSeenAt: now,
        },
      ],
    }),

  // Degraded connector still serving its last-known-good snapshot (old sync).
  stale: (now) =>
    compose(now, {
      health: buildHealth(now, {
        qbittorrent: {
          status: "degraded",
          lastError: "Read timed out; showing last-known-good",
          lastSuccessAt: now - 8 * MINUTE,
        },
      }),
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - 3 * MINUTE,
      },
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "downloads",
    }),

  "zfs-warning": (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionEmpty(),
      zfs: zfsWarning(now),
      telemetryProfile: "idle",
      attention: [
        {
          ruleId: "zfs.capacity.warning",
          alertId: "zfs.capacity.warning:DataStore",
          severity: "warning",
          title: "Pool filling",
          detail: "DataStore is 87% logically full (86% physical allocation).",
          source: "zfs",
          subject: "DataStore",
          firstSeenAt: now - 2 * HOUR,
          lastSeenAt: now,
        },
      ],
    }),

  "zfs-degraded": (now) =>
    compose(now, {
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionEmpty(),
      zfs: zfsDegraded(now),
      telemetryProfile: "idle",
      attention: degradedAttention(now),
      activity: [
        {
          id: "ev-scrub",
          at: now - 30 * MINUTE,
          kind: "zfs.scrub.completed",
          severity: "warning",
          source: "zfs",
          message: "Scrub of eSATA completed with 4 errors",
        },
        ...baseActivity(now),
      ],
    }),

  unconfigured: (now) =>
    compose(now, {
      health: CONNECTOR_IDS.map((id) => ({
        id,
        status: "unavailable" as ConnectorStatus,
        configured: false,
        lastSuccessAt: null,
        lastError: null,
        configError: null,
        pollIntervalMs: appConfig.pollIntervalsMs[id],
      })),
      jellyfin: jellyfinUnavailable(),
      acquisition: acquisitionEmpty(),
      zfs: { pools: [] },
      telemetryProfile: "unconfigured",
      activity: [],
    }),

  // --- composite aliases ---
  active: (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - 2 * MINUTE,
      },
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "active",
      activity: [
        {
          id: "ev-1",
          at: now - 2 * MINUTE,
          kind: "playback.started",
          severity: "info",
          source: "jellyfin",
          message: "oliver started watching Dune: Part Two",
        },
        ...baseActivity(now),
      ],
    }),

  attention: (now) =>
    compose(now, {
      health: buildHealth(now, {
        qbittorrent: { status: "degraded", lastError: "Tracker timeout", lastSuccessAt: now - 3 * MINUTE },
      }),
      jellyfin: jellyfinIdle(now),
      acquisition: acquisitionStalled(),
      zfs: zfsDegraded(now),
      telemetryProfile: "idle",
      attention: [...degradedAttention(now), ...stalledAttention(now)],
    }),

  "container-mixed": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "container-mixed",
    }),

  "container-field-real": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "container-field-real",
    }),

  "container-field-stress": (now) =>
    compose(now, {
      jellyfin: {
        serverAvailable: true,
        version: "10.9.11",
        sessions: [session({ id: "s1", method: "direct-play" })],
        lastPlaybackAt: now - MINUTE,
      },
      acquisition: acquisitionActive(),
      zfs: zfsHealthy(now),
      telemetryProfile: "container-field-stress",
    }),
};

/** Build a full deterministic dashboard snapshot for a scenario. */
export function makeFakeSnapshot(
  scenario: FakeScenario = DEFAULT_SCENARIO,
  now: number = Date.now(),
): DashboardSnapshot {
  return BUILDERS[scenario](now);
}
