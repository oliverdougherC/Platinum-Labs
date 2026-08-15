/**
 * Shared, normalized domain types for the homelab dashboard.
 *
 * These are intentionally connector-agnostic: every service adapter (Jellyfin,
 * Sonarr, Radarr, qBittorrent, ZFS) normalizes its raw response into these
 * shapes so the UI never depends on a vendor payload. Real connector
 * implementations arrive in Milestone 02 (PLA-178..185); this scaffold defines
 * the contract and a fake producer (PLA-177 groundwork).
 *
 * Isomorphic and secret-free — safe to import from both server and client.
 */

export type ConnectorId =
  | "jellyfin"
  | "sonarr"
  | "radarr"
  | "qbittorrent"
  | "zfs"
  | "host";

/** Health of a single connector. Never encodes status by color alone in the UI. */
export type ConnectorStatus = "healthy" | "degraded" | "unavailable";

/** How the whole dashboard is currently sourcing data. */
export type DataMode = "fake" | "live";

export interface ConnectorHealth {
  id: ConnectorId;
  status: ConnectorStatus;
  /**
   * Whether this connector is configured at all. `false` is distinct from
   * `unavailable`: an unconfigured connector shows "not set up" rather than a
   * failure, and the UI must render the two differently (spec §12).
   */
  configured: boolean;
  /** Epoch ms of the last successful poll, or null if never. */
  lastSuccessAt: number | null;
  /** Sanitized, secret-free error message when degraded/unavailable. */
  lastError: string | null;
  /**
   * Set when the connector is half-configured (e.g. URL without API key). Names
   * the missing field(s) only — never echoes a secret value. Distinct from
   * `lastError` (a runtime poll failure) and from `configured: false` (a clean,
   * intentional absence).
   */
  configError: string | null;
  /** Configured poll interval in milliseconds. */
  pollIntervalMs: number;
}

/**
 * Is a connector's last-known-good data stale? Derived, not stored: a connector
 * can be serving cached data (status !== healthy) while its snapshot is still
 * shown with a stale indicator. Returns false when never-synced.
 */
export function isConnectorStale(
  health: ConnectorHealth,
  now: number,
  staleFactor = 3,
): boolean {
  if (health.lastSuccessAt === null) return false;
  return now - health.lastSuccessAt > health.pollIntervalMs * staleFactor;
}

export type PlaybackMethod = "direct-play" | "direct-stream" | "transcode";

export interface JellyfinSession {
  id: string;
  user: string;
  title: string;
  /** Set for episodic content, e.g. "S02E05 — Title". */
  subtitle: string | null;
  method: PlaybackMethod;
  /** 0..1 fraction of the item watched. */
  progress: number;
  /** e.g. "1080p", "4K". */
  resolution: string | null;
  /** Total stream bitrate in bits/sec, when known. */
  bitrateBps: number | null;
}

export interface JellyfinSnapshot {
  serverAvailable: boolean;
  version: string | null;
  sessions: JellyfinSession[];
  /** Epoch ms of the most recent playback, for the idle "time since" line. */
  lastPlaybackAt: number | null;
}

export type AcquisitionState =
  | "searching"
  | "downloading"
  | "importing"
  | "stalled"
  | "failed"
  | "completed";

export interface AcquisitionItem {
  id: string;
  source: "sonarr" | "radarr" | "qbittorrent";
  title: string;
  quality: string | null;
  state: AcquisitionState;
  /** 0..1 fraction complete. */
  progress: number;
  /** Bytes/sec transfer rate, when downloading. */
  rateBps: number | null;
  /** Seconds remaining, when known. */
  etaSeconds: number | null;
  /**
   * Opaque, stable key for correlating the SAME acquisition across services —
   * a Servarr queue item and the qBittorrent transfer moving it. Derived by a
   * one-way fold of the torrent infohash (Servarr's `downloadId` ↔ qB's `hash`),
   * so it is safe to expose: it never contains the raw infohash. Absent for
   * non-torrent downloads (e.g. usenet) and when no infohash is available.
   */
  correlationKey?: string | null;
}

/**
 * A normalized, meaningful Sonarr/Radarr *history* event (import / failure),
 * derived from `/api/v3/history` rather than inferred from a queue item
 * disappearing. Turned into an `ActivityEvent` server-side; the raw upstream
 * record never reaches the client.
 */
export interface ServarrHistoryEvent {
  /** Stable dedup id (`<source>-history-<recordId>`); idempotent across overlapping windows. */
  id: string;
  source: "sonarr" | "radarr";
  kind: "media.imported" | "transfer.failed";
  /** Epoch ms of the event (parsed from the record's ISO date). */
  at: number;
  title: string;
  quality: string | null;
}

/** A Sonarr/Radarr connector snapshot: the active queue plus recent history. */
export interface ServarrSnapshot {
  items: AcquisitionItem[];
  /** Bounded, deduped recent history events (may be empty if history is degraded). */
  events: ServarrHistoryEvent[];
}

export interface AcquisitionRollup {
  downloading: number;
  importing: number;
  failedOrStalled: number;
  /** Aggregate throughput in bytes/sec across active transfers. */
  aggregateRateBps: number;
}

export interface AcquisitionSnapshot {
  items: AcquisitionItem[];
  rollup: AcquisitionRollup;
}

export type PoolHealth = "ONLINE" | "DEGRADED" | "FAULTED" | "OFFLINE" | "UNAVAIL";

/**
 * Pool-allocation (`zpool list`) view: the space the pool manages AFTER vdev
 * replication topology. On a mirror, SIZE is one side (~2 TB for a 2×2 TB
 * mirror); on RAIDZ it includes parity. It is NOT the space files can use
 * (PLA-264) and it is NOT installed raw device capacity (PLA-274) — never
 * label these values as either. Installed device capacity would need per-leaf
 * device sizes, which the collector does not gather today.
 */
export interface ZfsPoolAllocation {
  /** zpool SIZE — pool allocation size in bytes. */
  sizeBytes: number;
  /** zpool ALLOC — allocated bytes within the pool's allocation space. */
  allocBytes: number;
  /** zpool FREE — unallocated bytes within the pool's allocation space. */
  freeBytes: number;
  /** ALLOC/SIZE, 0..1. Matches `zpool list` CAP. */
  capFraction: number;
  /** zpool FRAG percentage, when reported. */
  fragPercent: number | null;
}

/**
 * Logical (root dataset, `zfs list`) capacity view: what files/datasets can
 * actually consume. USED+AVAIL is the user-facing usable total.
 */
export interface ZfsPoolLogical {
  /** Root dataset USED in bytes. */
  usedBytes: number;
  /** Root dataset AVAIL in bytes. */
  availBytes: number;
  /** USED + AVAIL. */
  totalBytes: number;
  /** USED / (USED+AVAIL), 0..1. */
  usedFraction: number;
}

/**
 * Current pool scan state. `finished` + `scrubErrors > 0` represents a scrub
 * that completed with errors (a "failed" scrub); `resilvering` covers an
 * in-progress resilver. Preserved from `zpool status` without exposing raw
 * command output.
 */
export type ZfsScanState = "none" | "scrubbing" | "resilvering" | "finished";

export interface ZfsPool {
  name: string;
  /**
   * Headline capacity used for display, trends, and history. Logical (root
   * dataset USED / USED+AVAIL) whenever the collector reports datasets;
   * zpool allocation values only as a labeled fallback for old collectors.
   * `capacityBasis` says which one this is — the UI must label accordingly.
   */
  usedBytes: number;
  totalBytes: number;
  /** 0..1 fraction used (derived, but carried explicitly for display). */
  capacityFraction: number;
  capacityBasis: "logical" | "pool-allocation";
  /** `zpool list` allocation-space view — always present. */
  allocation: ZfsPoolAllocation;
  /** Root-dataset logical view — null when the collector predates PLA-264. */
  logical: ZfsPoolLogical | null;
  health: PoolHealth;
  /** Current scan/scrub/resilver state. */
  scan: ZfsScanState;
  lastScrubAt: number | null;
  scrubErrors: number;
}

export interface ZfsSnapshot {
  pools: ZfsPool[];
}

// --- Host performance telemetry (PLA-265) -----------------------------------

/**
 * Per-domain availability. Missing telemetry is NEVER serialized as zero:
 * a domain that cannot be collected is `unavailable` (collector failed),
 * `not-configured` (intentionally absent, e.g. no GPU provider), or `stale`
 * (last-known-good older than its freshness window). `value` holds the
 * last-known-good sample for `available`/`stale`, null otherwise.
 */
export type TelemetryStatus =
  | "available"
  | "stale"
  | "unavailable"
  | "not-configured";

export interface TelemetryDomain<T> {
  status: TelemetryStatus;
  /** Epoch ms of the sample in `value`, or null when there has never been one. */
  updatedAt: number | null;
  value: T | null;
}

export interface CpuTelemetry {
  /** 0..1 total utilization across all logical CPUs. */
  totalFraction: number;
  /** 0..1 utilization per logical CPU, index = kernel cpuN order. Length is the real core count — never padded or truncated. */
  perCore: number[];
  /** Load averages; null when the source did not report them (never fabricated as 0). */
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

export interface MemoryTelemetry {
  totalBytes: number;
  /** total - available (the kernel's own reclaimable-aware estimate). */
  usedBytes: number;
  availableBytes: number;
  /** null when the source did not report swap (unknown ≠ "no swap": 0 means a real swapless host). */
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}

export interface GpuTelemetry {
  name: string;
  /** 0..1 GPU utilization. */
  utilizationFraction: number;
  vramUsedBytes: number;
  vramTotalBytes: number;
  temperatureC: number | null;
  powerWatts: number | null;
}

export interface NetworkTelemetry {
  /** Aggregate receive rate across selected physical interfaces, bytes/sec. */
  rxBps: number;
  /** Aggregate transmit rate, bytes/sec. */
  txBps: number;
  /** Interfaces aggregated into the totals (informational). */
  interfaces: string[];
}

export interface PoolIoTelemetry {
  /** Pool name matching `ZfsPool.name`, or "other" for unpooled devices. */
  pool: string;
  readBps: number;
  writeBps: number;
}

export interface DiskIoTelemetry {
  /** Aggregate read throughput across physical block devices, bytes/sec. */
  readBps: number;
  writeBps: number;
  /** Per-pool aggregation when the collector can map devices to pools. */
  pools: PoolIoTelemetry[];
}

export type ContainerState =
  | "running"
  | "paused"
  | "restarting"
  | "exited"
  | "dead"
  | "created";

export interface DockerContainerTelemetry {
  name: string;
  state: ContainerState;
  /** Docker health status when a healthcheck exists. */
  health: "healthy" | "unhealthy" | "starting" | null;
  /** null when the source endpoint does not know it (`/containers/json` does not) — renders "—", never 0. */
  restartCount: number | null;
  /** 0..1 of one core (can exceed 1 for multi-core usage); null when stats were not sampled. */
  cpuFraction: number | null;
  memoryBytes: number | null;
}

export interface DockerTelemetry {
  total: number;
  running: number;
  healthy: number;
  unhealthy: number;
  restarting: number;
  containers: DockerContainerTelemetry[];
}

export interface ArcTelemetry {
  sizeBytes: number;
  /** ARC target size (arcstats `c`); null when the source did not report it. */
  targetBytes: number | null;
  /** 0..1 lifetime hit ratio, when derivable. */
  hitRatio: number | null;
}

/** One normalized host-telemetry snapshot. Every domain is independently available. */
export interface HostTelemetrySnapshot {
  cpu: TelemetryDomain<CpuTelemetry>;
  memory: TelemetryDomain<MemoryTelemetry>;
  gpu: TelemetryDomain<GpuTelemetry>;
  network: TelemetryDomain<NetworkTelemetry>;
  disk: TelemetryDomain<DiskIoTelemetry>;
  docker: TelemetryDomain<DockerTelemetry>;
  arc: TelemetryDomain<ArcTelemetry>;
}

/** A single point in a bounded telemetry history series. */
export interface TelemetryHistoryPoint {
  t: number;
  v: number;
}

/**
 * Short bounded rolling histories for rail sparklines and flow smoothing.
 * Server-side memory only — never persisted, always length-capped.
 */
export interface TelemetryHistory {
  cpuTotal: TelemetryHistoryPoint[];
  netRx: TelemetryHistoryPoint[];
  netTx: TelemetryHistoryPoint[];
  diskRead: TelemetryHistoryPoint[];
  diskWrite: TelemetryHistoryPoint[];
}

export type EventKind =
  | "playback.started"
  | "playback.stopped"
  | "download.started"
  | "media.imported"
  | "transfer.completed"
  | "transfer.failed"
  | "transfer.stalled"
  | "transfer.recovered"
  | "zfs.scrub.completed"
  | "zfs.scrub.failed"
  | "pool.health.changed"
  | "connector.lost"
  | "connector.recovered"
  | "alert.opened"
  | "alert.resolved"
  | "request.approved"
  | "request.failed";

export type Severity = "info" | "warning" | "critical";

/**
 * Services that can emit activity events. Seerr is interactive (search/request
 * on demand), not a polled connector, so it extends the event vocabulary
 * without joining the `ConnectorId` health/polling system (PLA-256).
 */
export type ActivitySource = ConnectorId | "seerr";

export interface ActivityEvent {
  id: string;
  at: number;
  kind: EventKind;
  severity: Severity;
  source: ActivitySource;
  message: string;
  /**
   * Optional structured subject (session id, queue-item id, pool or connector
   * name). Kept so later command/LLM summaries can group/reference events
   * without re-parsing `message`.
   */
  subject?: string;
}

export interface AttentionItem {
  /** Reusable rule class id, e.g. "zfs.capacity.critical". Not unique per pool. */
  ruleId: string;
  /**
   * Stable alert-instance id — a rule/source/subject combination that is unique
   * across simultaneously-firing entities (e.g. two pools breaching the same
   * capacity rule). Falls back to `ruleId` when a rule can only fire once.
   */
  alertId: string;
  severity: Severity;
  title: string;
  detail: string;
  source: ConnectorId;
  /** Entity the alert is about (pool name, torrent id, connector id), if any. */
  subject?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Epoch ms the alert cleared; set only on resolved lifecycle records. */
  resolvedAt?: number | null;
}

/** A single throughput history point. */
export interface ThroughputSamplePoint {
  t: number;
  bps: number;
}

/**
 * History windows powering the charts. Kept in the aggregate contract so the
 * client fetches everything in one request (no N+1).
 */
export interface DashboardHistory {
  /** Recent aggregate throughput (media chart). */
  throughput: ThroughputSamplePoint[];
  /** Pool names present as series in `storage`. */
  storageSeries: string[];
  /** Storage-trend rows: `{ t, <pool>: usedBytes, … }`. */
  storage: Array<{ t: number } & Record<string, number>>;
}

/** The single normalized shape the frontend renders. */
export interface DashboardSnapshot {
  mode: DataMode;
  /** Epoch ms this snapshot was generated. */
  generatedAt: number;
  health: ConnectorHealth[];
  jellyfin: JellyfinSnapshot;
  acquisition: AcquisitionSnapshot;
  zfs: ZfsSnapshot;
  /** Host performance telemetry (PLA-265). */
  telemetry: HostTelemetrySnapshot;
  /** Bounded rolling telemetry histories for rail sparklines. */
  telemetryHistory?: TelemetryHistory;
  attention: AttentionItem[];
  activity: ActivityEvent[];
  /**
   * Whether the activity feed was read successfully. `false` means the
   * persistence read failed and the empty `activity` array is "unknown", not
   * "nothing happened" — the UI must render those distinctly. Absent/`true`
   * means the (possibly empty) feed is authoritative.
   */
  activityAvailable?: boolean;
  /** Chart history windows (optional; present in aggregate responses). */
  history?: DashboardHistory;
  /**
   * Operator-declared media pool name (HOMELAB_MEDIA_POOL), or null/absent.
   * The topology may attach import/playback flows to this pool ONLY — never to
   * a pool inferred from dominant I/O (PLA-275). Null means the flows end at a
   * generic storage endpoint.
   */
  mediaPool?: string | null;
}
