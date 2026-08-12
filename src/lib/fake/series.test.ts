import { describe, expect, it } from "vitest";
import {
  eventBuckets,
  storageTrendSeries,
  throughputSeries,
} from "@/lib/fake/series";

const NOW = 1_754_000_000_000;

describe("throughputSeries", () => {
  it("is deterministic and ordered oldest→newest", () => {
    const a = throughputSeries({ now: NOW, level: "light" });
    const b = throughputSeries({ now: NOW, level: "light" });
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) {
      expect(a[i]!.t).toBeGreaterThan(a[i - 1]!.t);
    }
    expect(a[a.length - 1]!.t).toBe(NOW);
  });

  it("high activity averages well above light", () => {
    const avg = (xs: { bps: number }[]) =>
      xs.reduce((s, x) => s + x.bps, 0) / xs.length;
    expect(avg(throughputSeries({ now: NOW, level: "high" }))).toBeGreaterThan(
      avg(throughputSeries({ now: NOW, level: "light" })),
    );
  });

  it("empty level yields all-zero points (missing-data state)", () => {
    expect(
      throughputSeries({ now: NOW, level: "empty" }).every((p) => p.bps === 0),
    ).toBe(true);
  });
});

describe("storageTrendSeries", () => {
  const pools = [
    { name: "tank", endBytes: 12 * 1024 ** 4, totalBytes: 20 * 1024 ** 4 },
    { name: "backup", endBytes: 3 * 1024 ** 4, totalBytes: 8 * 1024 ** 4 },
  ];

  it("ends at each pool's current value and trends upward", () => {
    const rows = storageTrendSeries({ now: NOW, days: 30, pools });
    const last = rows[rows.length - 1]!;
    const first = rows[0]!;
    const lastTank = last.tank!;
    expect(lastTank).toBeGreaterThan(first.tank!);
    // Ends within ~1% of the pool's current value (small deterministic wobble).
    const relError = Math.abs(lastTank - pools[0]!.endBytes) / pools[0]!.endBytes;
    expect(relError).toBeLessThan(0.01);
  });

  it("returns no rows when empty (missing-data state)", () => {
    expect(
      storageTrendSeries({ now: NOW, pools, level: "empty" }),
    ).toHaveLength(0);
    expect(storageTrendSeries({ now: NOW, pools: [] })).toHaveLength(0);
  });
});

describe("eventBuckets", () => {
  it("produces one bucket per hour, oldest→newest", () => {
    const b = eventBuckets({ now: NOW, hours: 24, level: "light" });
    expect(b).toHaveLength(24);
    expect(b[b.length - 1]!.t).toBe(NOW);
  });

  it("empty level has zero counts but still renders buckets", () => {
    const b = eventBuckets({ now: NOW, hours: 12, level: "empty" });
    expect(b).toHaveLength(12);
    expect(b.every((x) => x.count === 0)).toBe(true);
  });

  it("high level is denser than light", () => {
    const total = (xs: { count: number }[]) =>
      xs.reduce((s, x) => s + x.count, 0);
    expect(total(eventBuckets({ now: NOW, level: "high" }))).toBeGreaterThan(
      total(eventBuckets({ now: NOW, level: "light" })),
    );
  });
});
