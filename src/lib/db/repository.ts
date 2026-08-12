/**
 * Typed persistence + query helpers (PLA-179).
 *
 * DB-agnostic: every function takes a `DB` handle, so the whole layer is unit-
 * tested against an in-memory database. Queries are indexed for the three hot
 * paths — the ~45m media throughput chart, the 30/90d storage trend, and the
 * recent-activity feed.
 */

import type { ActivityEvent, ConnectorId, Severity } from "@/lib/types";
import type { DB } from "@/lib/db/types";

export interface ThroughputSample {
  t: number;
  bps: number;
}
export interface StorageSample {
  t: number;
  pool: string;
  usedBytes: number;
  totalBytes: number;
}

// --- writes ---------------------------------------------------------------

export function insertThroughput(db: DB, sample: ThroughputSample): void {
  db.prepare("INSERT INTO throughput_samples (t, bps) VALUES (?, ?)").run(
    sample.t,
    Math.round(sample.bps),
  );
}

export function insertStorageSample(db: DB, s: StorageSample): void {
  db.prepare(
    "INSERT INTO storage_samples (t, pool, used_bytes, total_bytes) VALUES (?, ?, ?, ?)",
  ).run(s.t, s.pool, Math.round(s.usedBytes), Math.round(s.totalBytes));
}

/** Insert an event; duplicate ids are ignored (idempotent event derivation). */
export function insertActivityEvent(db: DB, e: ActivityEvent): void {
  db.prepare(
    `INSERT OR IGNORE INTO activity_events (id, at, kind, severity, source, message, subject)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.id, e.at, e.kind, e.severity, e.source, e.message, e.subject ?? null);
}

/** Record a health transition only when the status actually changed. */
export function recordHealthTransition(
  db: DB,
  at: number,
  connector: ConnectorId,
  status: string,
): boolean {
  const last = db
    .prepare(
      "SELECT status FROM connector_health WHERE connector = ? ORDER BY at DESC, id DESC LIMIT 1",
    )
    .get(connector) as { status: string } | undefined;
  if (last && last.status === status) return false;
  db.prepare(
    "INSERT INTO connector_health (at, connector, status) VALUES (?, ?, ?)",
  ).run(at, connector, status);
  return true;
}

export interface AlertRecord {
  /** Stable per-instance id (rule + subject), unique across simultaneous entities. */
  alertId: string;
  /** Reusable rule class id. */
  ruleId: string;
  severity: Severity;
  title: string;
  detail: string;
  source: ConnectorId;
  subject: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Upsert an active alert instance: keep first_seen, bump last_seen, clear resolved. */
export function upsertAlert(db: DB, a: AlertRecord): void {
  db.prepare(
    `INSERT INTO alerts (alert_id, rule_id, severity, title, detail, source, subject, first_seen, last_seen, resolved_at)
     VALUES (@alertId, @ruleId, @severity, @title, @detail, @source, @subject, @firstSeenAt, @lastSeenAt, NULL)
     ON CONFLICT(alert_id) DO UPDATE SET
       severity = excluded.severity,
       title = excluded.title,
       detail = excluded.detail,
       last_seen = excluded.last_seen,
       resolved_at = NULL`,
  ).run(a);
}

export function resolveAlert(db: DB, alertId: string, at: number): void {
  db.prepare(
    "UPDATE alerts SET resolved_at = ? WHERE alert_id = ? AND resolved_at IS NULL",
  ).run(at, alertId);
}

export interface StoredAlert extends AlertRecord {
  resolvedAt: number | null;
}

/** Currently-open (unresolved) alerts, most-recently-seen first. */
export function activeAlerts(db: DB): StoredAlert[] {
  return db
    .prepare(
      `SELECT alert_id AS alertId, rule_id AS ruleId, severity, title, detail,
              source, subject, first_seen AS firstSeenAt, last_seen AS lastSeenAt,
              resolved_at AS resolvedAt
       FROM alerts WHERE resolved_at IS NULL ORDER BY last_seen DESC`,
    )
    .all() as StoredAlert[];
}

export function insertAudit(
  db: DB,
  at: number,
  action: string,
  result: string,
  caller: string | null = null,
): void {
  db.prepare(
    "INSERT INTO action_audit (at, action, result, caller) VALUES (?, ?, ?, ?)",
  ).run(at, action, result, caller);
}

// --- reads ----------------------------------------------------------------

/** Throughput points within [now - windowMs, now], oldest first. */
export function recentThroughput(
  db: DB,
  now: number,
  windowMs: number,
): ThroughputSample[] {
  return db
    .prepare(
      "SELECT t, bps FROM throughput_samples WHERE t >= ? ORDER BY t ASC",
    )
    .all(now - windowMs) as ThroughputSample[];
}

/** Storage samples within the last `days`, oldest first. */
export function storageTrend(db: DB, now: number, days: number): StorageSample[] {
  const since = now - days * 86_400_000;
  return db
    .prepare(
      `SELECT t, pool, used_bytes AS usedBytes, total_bytes AS totalBytes
       FROM storage_samples WHERE t >= ? ORDER BY t ASC`,
    )
    .all(since) as StorageSample[];
}

/** Most recent activity events, newest first. */
export function recentEvents(db: DB, limit = 50): ActivityEvent[] {
  return db
    .prepare(
      `SELECT id, at, kind, severity, source, message, subject
       FROM activity_events ORDER BY at DESC LIMIT ?`,
    )
    .all(limit) as ActivityEvent[];
}

/**
 * Epoch ms of the most recent meaningful playback event, or null. Lets the live
 * dashboard show "Last played N ago" after playback stops, since Jellyfin's
 * `/Sessions` only reports *current* sessions (PLA-187).
 */
export function lastPlaybackAt(db: DB): number | null {
  const row = db
    .prepare(
      `SELECT MAX(at) AS at FROM activity_events
       WHERE kind IN ('playback.started', 'playback.stopped')`,
    )
    .get() as { at: number | null };
  return row.at ?? null;
}

export function countRows(db: DB, table: string): number {
  // `table` is never user input — internal callers pass literal names.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}
