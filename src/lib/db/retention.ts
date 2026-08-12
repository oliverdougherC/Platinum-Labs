/**
 * Retention + downsampling (PLA-179).
 *
 * Keeps the database bounded so a dashboard left running for months never grows
 * without limit. Retention windows follow the spec's suggested defaults; the
 * throughput table additionally downsamples older high-frequency points into
 * coarse buckets before the retention cutoff removes the rest.
 */

import type { DB } from "@/lib/db/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface RetentionPolicy {
  throughputMs: number;
  storageMs: number;
  activityMs: number;
  healthMs: number;
  /** Resolved alerts older than this are removed; unresolved are always kept. */
  resolvedAlertMs: number;
  auditMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  throughputMs: 48 * HOUR,
  storageMs: 365 * DAY,
  activityMs: 90 * DAY,
  healthMs: 30 * DAY,
  resolvedAlertMs: 90 * DAY,
  auditMs: 180 * DAY,
};

export interface RetentionResult {
  throughput: number;
  storage: number;
  activity: number;
  health: number;
  alerts: number;
  audit: number;
}

/** Delete rows older than each table's cutoff. Returns per-table delete counts. */
export function runRetention(
  db: DB,
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionResult {
  const del = (sql: string, cutoff: number): number =>
    db.prepare(sql).run(cutoff).changes;

  const tx = db.transaction((): RetentionResult => {
    return {
      throughput: del(
        "DELETE FROM throughput_samples WHERE t < ?",
        now - policy.throughputMs,
      ),
      storage: del(
        "DELETE FROM storage_samples WHERE t < ?",
        now - policy.storageMs,
      ),
      activity: del(
        "DELETE FROM activity_events WHERE at < ?",
        now - policy.activityMs,
      ),
      health: del(
        "DELETE FROM connector_health WHERE at < ?",
        now - policy.healthMs,
      ),
      alerts: db
        .prepare(
          "DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?",
        )
        .run(now - policy.resolvedAlertMs).changes,
      audit: del(
        "DELETE FROM action_audit WHERE at < ?",
        now - policy.auditMs,
      ),
    };
  });

  return tx();
}

export interface DownsampleOptions {
  /** Points older than this (relative to now) are downsampled. */
  olderThanMs: number;
  /** Bucket width for the aggregate. */
  bucketMs: number;
}

/**
 * Collapse high-frequency throughput points older than `olderThanMs` into
 * bucket averages of width `bucketMs`, replacing the raw rows. Recent points
 * (within the window) are untouched so the live 45m chart keeps full detail.
 *
 * Returns the net change in row count (negative = rows removed).
 */
export function downsampleThroughput(
  db: DB,
  now: number,
  opts: DownsampleOptions,
): number {
  const cutoff = now - opts.olderThanMs;
  const bucket = Math.max(1, Math.floor(opts.bucketMs));

  const tx = db.transaction((): number => {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM throughput_samples").get() as {
        n: number;
      }
    ).n;

    // Aggregate old rows into bucket averages. Uses integer modulo (not `/`)
    // for bucketing: a bound numeric parameter makes SQLite's `/` evaluate as
    // REAL, which would leave every point in its own bucket.
    const buckets = db
      .prepare(
        `SELECT (t - (t % @bucket)) AS bucketStart, CAST(AVG(bps) AS INTEGER) AS avgBps
         FROM throughput_samples
         WHERE t < @cutoff
         GROUP BY (t - (t % @bucket))`,
      )
      .all({ bucket, cutoff }) as { bucketStart: number; avgBps: number }[];

    if (buckets.length === 0) return 0;

    db.prepare("DELETE FROM throughput_samples WHERE t < ?").run(cutoff);
    const insert = db.prepare(
      "INSERT INTO throughput_samples (t, bps) VALUES (?, ?)",
    );
    for (const b of buckets) insert.run(b.bucketStart, b.avgBps);

    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM throughput_samples").get() as {
        n: number;
      }
    ).n;
    return after - before;
  });

  return tx();
}

/**
 * Collapse storage samples older than `olderThanMs` into per-pool daily buckets
 * (one representative average row per pool per day), keeping recent samples at
 * full resolution for the 30-day trend. Bounds long-term storage density so the
 * 90/365-day views stay cheap. Returns the net change in row count.
 */
export function downsampleStorage(
  db: DB,
  now: number,
  opts: DownsampleOptions,
): number {
  const cutoff = now - opts.olderThanMs;
  const bucket = Math.max(1, Math.floor(opts.bucketMs));

  const tx = db.transaction((): number => {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM storage_samples").get() as { n: number }
    ).n;

    const buckets = db
      .prepare(
        `SELECT (t - (t % @bucket)) AS bucketStart, pool,
                CAST(AVG(used_bytes) AS INTEGER)  AS usedBytes,
                CAST(AVG(total_bytes) AS INTEGER) AS totalBytes
         FROM storage_samples
         WHERE t < @cutoff
         GROUP BY (t - (t % @bucket)), pool`,
      )
      .all({ bucket, cutoff }) as {
      bucketStart: number;
      pool: string;
      usedBytes: number;
      totalBytes: number;
    }[];

    if (buckets.length === 0) return 0;

    db.prepare("DELETE FROM storage_samples WHERE t < ?").run(cutoff);
    const insert = db.prepare(
      "INSERT INTO storage_samples (t, pool, used_bytes, total_bytes) VALUES (?, ?, ?, ?)",
    );
    for (const b of buckets) insert.run(b.bucketStart, b.pool, b.usedBytes, b.totalBytes);

    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM storage_samples").get() as { n: number }
    ).n;
    return after - before;
  });

  return tx();
}

export interface MaintenanceResult {
  retention: RetentionResult;
  throughputDelta: number;
  storageDelta: number;
}

/**
 * One production maintenance pass: downsample high-frequency history into coarse
 * buckets, then delete anything past its retention cutoff. Safe to run on a low
 * cadence (hourly/daily); intended to be wrapped in `tryPersist` so a failure is
 * logged but never crashes the dashboard.
 */
export function runMaintenance(
  db: DB,
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): MaintenanceResult {
  // Downsample points older than 90 min into 5-min buckets — keeps the live
  // ~45m chart at full resolution while collapsing the tail.
  const throughputDelta = downsampleThroughput(db, now, {
    olderThanMs: 90 * 60_000,
    bucketMs: 5 * 60_000,
  });
  // Downsample storage older than 30 days into daily buckets.
  const storageDelta = downsampleStorage(db, now, {
    olderThanMs: 30 * DAY,
    bucketMs: DAY,
  });
  const retention = runRetention(db, now, policy);
  return { retention, throughputDelta, storageDelta };
}
