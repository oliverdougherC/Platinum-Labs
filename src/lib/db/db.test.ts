import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/lib/db/migrate";
import {
  countRows,
  insertActivityEvent,
  insertStorageSample,
  insertThroughput,
  recentEvents,
  recentThroughput,
  recordHealthTransition,
  resolveAlert,
  storageTrend,
  upsertAlert,
} from "@/lib/db/repository";
import {
  DEFAULT_RETENTION,
  downsampleThroughput,
  runRetention,
} from "@/lib/db/retention";
import { safePersist } from "@/lib/db/safe";
import type { DB } from "@/lib/db/types";
import type { ActivityEvent } from "@/lib/types";

let db: DB;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const NOW = 1_754_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function event(id: string, at: number): ActivityEvent {
  return { id, at, kind: "media.imported", severity: "info", source: "radarr", message: `m-${id}` };
}

describe("migrate", () => {
  it("creates all tables and is idempotent", () => {
    // A second migrate applies nothing.
    expect(migrate(db)).toBe(0);
    for (const table of [
      "throughput_samples",
      "storage_samples",
      "activity_events",
      "connector_health",
      "alerts",
      "action_audit",
    ]) {
      expect(countRows(db, table)).toBe(0); // empty DB boots cleanly
    }
  });

  it("a fresh database returns empty query results without error", () => {
    expect(recentThroughput(db, NOW, HOUR)).toEqual([]);
    expect(storageTrend(db, NOW, 30)).toEqual([]);
    expect(recentEvents(db)).toEqual([]);
  });
});

describe("throughput + storage samples", () => {
  it("recentThroughput filters by window and orders ascending", () => {
    insertThroughput(db, { t: NOW - 2 * HOUR, bps: 100 });
    insertThroughput(db, { t: NOW - 30 * 60_000, bps: 200 });
    insertThroughput(db, { t: NOW - 5 * 60_000, bps: 300 });
    const pts = recentThroughput(db, NOW, HOUR);
    expect(pts.map((p) => p.bps)).toEqual([200, 300]); // 2h-old excluded
  });

  it("storageTrend returns per-pool samples within the range", () => {
    insertStorageSample(db, { t: NOW - 40 * DAY, pool: "tank", usedBytes: 1, totalBytes: 10 });
    insertStorageSample(db, { t: NOW - 5 * DAY, pool: "tank", usedBytes: 2, totalBytes: 10 });
    const rows = storageTrend(db, NOW, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedBytes).toBe(2);
  });
});

describe("activity events", () => {
  it("dedupes by id and returns newest first", () => {
    insertActivityEvent(db, event("a", NOW - 10_000));
    insertActivityEvent(db, event("a", NOW - 10_000)); // duplicate id
    insertActivityEvent(db, event("b", NOW - 1_000));
    const events = recentEvents(db);
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe("b"); // newest first
  });
});

describe("connector health transitions", () => {
  it("records only on status change", () => {
    expect(recordHealthTransition(db, NOW, "jellyfin", "healthy")).toBe(true);
    expect(recordHealthTransition(db, NOW + 1, "jellyfin", "healthy")).toBe(false);
    expect(recordHealthTransition(db, NOW + 2, "jellyfin", "degraded")).toBe(true);
    expect(countRows(db, "connector_health")).toBe(2);
  });
});

describe("alerts lifecycle", () => {
  const alert = {
    alertId: "zfs.pool.degraded:backup",
    ruleId: "zfs.pool.degraded",
    severity: "critical" as const,
    title: "Pool degraded",
    detail: "backup is DEGRADED",
    source: "zfs" as const,
    subject: "backup",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  };

  it("upsert keeps first_seen, bumps last_seen; resolve stamps resolved_at", () => {
    upsertAlert(db, alert);
    upsertAlert(db, { ...alert, lastSeenAt: NOW + 60_000 });
    const row = db.prepare("SELECT * FROM alerts WHERE alert_id = ?").get(alert.alertId) as {
      first_seen: number;
      last_seen: number;
      resolved_at: number | null;
    };
    expect(row.first_seen).toBe(NOW);
    expect(row.last_seen).toBe(NOW + 60_000);
    expect(row.resolved_at).toBeNull();

    resolveAlert(db, alert.alertId, NOW + 120_000);
    const resolved = db.prepare("SELECT resolved_at FROM alerts WHERE alert_id = ?").get(alert.alertId) as {
      resolved_at: number | null;
    };
    expect(resolved.resolved_at).toBe(NOW + 120_000);
  });

  it("tracks two subjects under the same rule as distinct alert instances", () => {
    upsertAlert(db, { ...alert, alertId: "zfs.capacity.critical:tank", ruleId: "zfs.capacity.critical", subject: "tank" });
    upsertAlert(db, { ...alert, alertId: "zfs.capacity.critical:backup", ruleId: "zfs.capacity.critical", subject: "backup" });
    expect(countRows(db, "alerts")).toBe(2);
  });
});

describe("retention keeps the database bounded", () => {
  it("deletes only rows older than each cutoff", () => {
    insertThroughput(db, { t: NOW - 3 * DAY, bps: 1 }); // older than 48h
    insertThroughput(db, { t: NOW - HOUR, bps: 2 }); // fresh
    insertActivityEvent(db, event("old", NOW - 100 * DAY));
    insertActivityEvent(db, event("new", NOW - DAY));

    const result = runRetention(db, NOW, DEFAULT_RETENTION);
    expect(result.throughput).toBe(1);
    expect(result.activity).toBe(1);
    expect(countRows(db, "throughput_samples")).toBe(1);
    expect(countRows(db, "activity_events")).toBe(1);
    expect(recentEvents(db)[0]!.id).toBe("new");
  });

  it("keeps unresolved alerts regardless of age", () => {
    upsertAlert(db, {
      alertId: "old.unresolved:x",
      ruleId: "old.unresolved",
      severity: "warning",
      title: "x",
      detail: "y",
      source: "qbittorrent",
      subject: "x",
      firstSeenAt: NOW - 400 * DAY,
      lastSeenAt: NOW - 400 * DAY,
    });
    runRetention(db, NOW);
    expect(countRows(db, "alerts")).toBe(1); // unresolved is retained
  });
});

describe("downsampleThroughput", () => {
  it("collapses old points into buckets and leaves recent detail intact", () => {
    // 20 old points within a single 15-min bucket, 3 recent points.
    for (let i = 0; i < 20; i++) {
      insertThroughput(db, { t: NOW - 6 * HOUR + i * 1_000, bps: 100 + i });
    }
    for (let i = 0; i < 3; i++) {
      insertThroughput(db, { t: NOW - 10 * 60_000 + i * 1_000, bps: 500 });
    }
    expect(countRows(db, "throughput_samples")).toBe(23);

    const delta = downsampleThroughput(db, NOW, {
      olderThanMs: HOUR, // anything older than 1h is downsampled
      bucketMs: 15 * 60_000,
    });
    expect(delta).toBeLessThan(0); // net rows removed
    // Recent 3 points survive untouched.
    expect(recentThroughput(db, NOW, HOUR)).toHaveLength(3);
    // Old 20 collapsed to a single bucket row.
    expect(countRows(db, "throughput_samples")).toBe(4);
  });
});

describe("safePersist", () => {
  it("swallows persistence errors and never throws", () => {
    const broken = new Database(":memory:");
    broken.close(); // any write now throws
    let captured: unknown = null;
    const ok = safePersist(
      broken,
      (d) => insertThroughput(d, { t: NOW, bps: 1 }),
      (e) => (captured = e),
    );
    expect(ok).toBe(false);
    expect(captured).not.toBeNull();
  });
});
