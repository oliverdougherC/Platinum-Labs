import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/lib/db/migrate";
import {
  countRows,
  insertStorageSample,
  insertThroughput,
} from "@/lib/db/repository";
import {
  DEFAULT_RETENTION,
  downsampleStorage,
  runMaintenance,
} from "@/lib/db/retention";
import type { DB } from "@/lib/db/types";

let db: DB;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("runMaintenance — bounded row growth (simulated long run)", () => {
  it("keeps throughput rows bounded over a simulated multi-day run", () => {
    // Simulate 3 days of a 5s aggregate loop (~51.8k raw samples) with hourly
    // maintenance. Without maintenance this table would grow unbounded.
    const start = 1_700_000_000_000;
    const stepMs = 5_000;
    const totalMs = 3 * 24 * 60 * 60_000;
    let now = start;
    let maintenanceAt = start;

    for (; now < start + totalMs; now += stepMs) {
      insertThroughput(db, { t: now, bps: (now % 7) * 1_000_000 });
      if (now - maintenanceAt >= 60 * 60_000) {
        runMaintenance(db, now);
        maintenanceAt = now;
      }
    }
    runMaintenance(db, now);

    const rows = countRows(db, "throughput_samples");
    // 48h retention: recent 90m at 5s full-res (~1080) + older 46.5h at 5m
    // buckets (~558). Comfortably under a few thousand — never ~50k.
    expect(rows).toBeLessThan(3_000);
    expect(rows).toBeGreaterThan(0);
  });

  it("collapses old storage samples into daily buckets", () => {
    const now = 1_700_000_000_000;
    const DAY = 86_400_000;
    // 200 samples/day for 40 days, single pool → 8000 rows before downsample.
    for (let d = 0; d < 40; d++) {
      for (let i = 0; i < 200; i++) {
        insertStorageSample(db, {
          t: now - (40 - d) * DAY + i * (DAY / 200),
          pool: "tank",
          usedBytes: 10 + d,
          totalBytes: 100,
        });
      }
    }
    const before = countRows(db, "storage_samples");
    downsampleStorage(db, now, { olderThanMs: 30 * DAY, bucketMs: DAY });
    const after = countRows(db, "storage_samples");
    expect(after).toBeLessThan(before);
    // Samples inside the recent 30-day window keep full resolution.
    expect(after).toBeGreaterThan(30 * 200 - 1);
  });

  it("is idempotent and stable when run repeatedly on steady input", () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5_000; i++) {
      insertThroughput(db, { t: now - i * 5_000, bps: 1_000_000 });
    }
    const first = runMaintenance(db, now);
    const rowsAfterFirst = countRows(db, "throughput_samples");
    // A second immediate pass removes nothing new (already downsampled/retained).
    runMaintenance(db, now);
    expect(countRows(db, "throughput_samples")).toBe(rowsAfterFirst);
    expect(first.retention).toBeDefined();
  });

  it("respects the configured retention policy cutoffs", () => {
    const now = 1_700_000_000_000;
    insertThroughput(db, { t: now - DEFAULT_RETENTION.throughputMs - 1, bps: 1 }); // expired
    insertThroughput(db, { t: now, bps: 2 }); // fresh
    runMaintenance(db, now);
    // The expired row is gone; the fresh one survives.
    const rows = countRows(db, "throughput_samples");
    expect(rows).toBe(1);
  });
});
