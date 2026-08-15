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
  | "zfs";

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
 * Current pool scan state. `finished` + `scrubErrors > 0` represents a scrub
 * that completed with errors (a "failed" scrub); `resilvering` covers an
 * in-progress resilver. Preserved from `zpool status` without exposing raw
 * command output.
 */
export type ZfsScanState = "none" | "scrubbing" | "resilvering" | "finished";

export interface ZfsPool {
  name: string;
  usedBytes: number;
  totalBytes: number;
  /** 0..1 fraction used (derived, but carried explicitly for display). */
  capacityFraction: number;
  health: PoolHealth;
  /** Current scan/scrub/resilver state. */
  scan: ZfsScanState;
  lastScrubAt: number | null;
  scrubErrors: number;
}

export interface ZfsSnapshot {
  pools: ZfsPool[];
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
}
