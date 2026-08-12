import { describe, expect, it } from "vitest";
import {
  dailyMedians,
  projectCapacity,
  projectionLabel,
  theilSenSlope,
  type StoragePoint,
} from "@/lib/dashboard/projection";

const DAY = 86_400_000;
const GiB = 1024 ** 3;
const TOTAL = 100 * GiB;
const NOW = 40 * DAY; // 40 days after epoch, day-aligned enough for tests

/** Build one sample per day for `days` days ending at (NOW - 1 day), used(day). */
function series(days: number, used: (dayIndex: number) => number): StoragePoint[] {
  const pts: StoragePoint[] = [];
  for (let i = 0; i < days; i++) {
    const t = NOW - (days - i) * DAY + DAY / 2; // midday sample
    pts.push({ t, usedBytes: used(i) });
  }
  return pts;
}

describe("dailyMedians", () => {
  it("collapses many intraday samples into one median per day", () => {
    const day = 10 * DAY;
    const pts: StoragePoint[] = [
      { t: day + 1_000, usedBytes: 10 },
      { t: day + 2_000, usedBytes: 1000 }, // spike
      { t: day + 3_000, usedBytes: 12 },
    ];
    const d = dailyMedians(pts);
    expect(d).toHaveLength(1);
    expect(d[0]!.usedBytes).toBe(12); // median, not the spike
  });
});

describe("theilSenSlope", () => {
  it("recovers a steady slope", () => {
    const d = dailyMedians(series(10, (i) => i * GiB));
    expect(theilSenSlope(d)).toBeCloseTo(GiB, -6);
  });
  it("is robust to a single outlier day", () => {
    const d = dailyMedians(series(15, (i) => (i === 7 ? 900 * GiB : i * GiB)));
    // Median pairwise slope stays ~1 GiB/day despite the spike.
    expect(theilSenSlope(d)! / GiB).toBeGreaterThan(0.5);
    expect(theilSenSlope(d)! / GiB).toBeLessThan(2);
  });
});

describe("projectCapacity", () => {
  it("returns no projection with insufficient history", () => {
    const r = projectCapacity(series(3, (i) => (10 + i) * GiB), { totalBytes: TOTAL, now: NOW });
    expect(r.projection).toBeNull();
    expect(r.dailyMedians.length).toBe(3); // still reports current data
  });

  it("projects a threshold date under steady growth", () => {
    // Start at 50 GiB, +1 GiB/day, total 100 GiB, threshold 80% = 80 GiB.
    const r = projectCapacity(series(14, (i) => (50 + i) * GiB), {
      totalBytes: TOTAL,
      now: NOW,
      thresholdFraction: 0.8,
    });
    expect(r.slopeBytesPerDay).toBeCloseTo(GiB, -6);
    expect(r.projection).not.toBeNull();
    // current ~63 GiB, need ~17 GiB at 1 GiB/day → ~17 days.
    expect(r.projection!.etaDays).toBeGreaterThan(10);
    expect(r.projection!.etaDays).toBeLessThan(25);
    expect(r.projection!.etaAt).toBeGreaterThan(NOW);
  });

  it("returns no projection for flat or shrinking usage", () => {
    const flat = projectCapacity(series(14, () => 40 * GiB), { totalBytes: TOTAL, now: NOW });
    expect(flat.projection).toBeNull();
    const shrinking = projectCapacity(series(14, (i) => (60 - i) * GiB), { totalBytes: TOTAL, now: NOW });
    expect(shrinking.projection).toBeNull();
    expect(shrinking.slopeBytesPerDay!).toBeLessThan(0);
  });

  it("ignores history before a large deletion (no absurd projection)", () => {
    // 10 days climbing to ~78 GiB, then a big delete to 20 GiB, then 10 days of
    // gentle +0.5 GiB/day growth. Projection must use only the post-delete slope.
    const pts: StoragePoint[] = [
      ...series(10, (i) => (70 + i) * GiB).map((p) => ({ ...p, t: p.t - 12 * DAY })),
      ...series(10, (i) => (20 + i * 0.5) * GiB),
    ];
    const r = projectCapacity(pts, { totalBytes: TOTAL, now: NOW });
    // Slope reflects the post-deletion segment (~0.5 GiB/day), not the jump.
    expect(r.slopeBytesPerDay! / GiB).toBeLessThan(1);
    expect(r.slopeBytesPerDay! / GiB).toBeGreaterThan(0);
  });

  it("is not fooled by a one-off ingest spike", () => {
    const r = projectCapacity(
      series(20, (i) => (40 + i * 0.2) * GiB + (i === 10 ? 30 * GiB : 0)),
      { totalBytes: TOTAL, now: NOW },
    );
    // ~0.2 GiB/day underlying trend; spike shouldn't inflate it wildly.
    expect(r.slopeBytesPerDay! / GiB).toBeLessThan(1);
  });

  it("handles sparse samples (a few days) without crashing", () => {
    const pts: StoragePoint[] = [
      { t: NOW - 20 * DAY, usedBytes: 40 * GiB },
      { t: NOW - 10 * DAY, usedBytes: 45 * GiB },
      { t: NOW - 2 * DAY, usedBytes: 48 * GiB },
    ];
    const r = projectCapacity(pts, { totalBytes: TOTAL, now: NOW, minDays: 3 });
    expect(r.dailyMedians.length).toBe(3);
    expect(r.projection).not.toBeNull(); // positive slope, distinct days
  });

  it("reports 30-day growth independently of the projection", () => {
    const r = projectCapacity(series(30, (i) => (10 + i) * GiB), { totalBytes: TOTAL, now: NOW });
    expect(r.growth30dBytes! / GiB).toBeCloseTo(29, 0);
  });
});

describe("projectionLabel", () => {
  it("phrases short/medium/long horizons", () => {
    expect(projectionLabel({ thresholdFraction: 0.8, etaDays: 20, etaAt: 0 })).toContain("~20 days");
    expect(projectionLabel({ thresholdFraction: 0.8, etaDays: 120, etaAt: 0 })).toContain("months");
    expect(projectionLabel({ thresholdFraction: 0.9, etaDays: 900, etaAt: 0 })).toContain("years");
  });
});
