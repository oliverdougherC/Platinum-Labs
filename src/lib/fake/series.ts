/**
 * Deterministic fake time-series generators for the chart gallery (PLA-176).
 *
 * No randomness: a small hash-based wobble keeps the shapes organic while
 * remaining identical for a fixed `now`, so gallery screenshots and tests are
 * stable. Isomorphic and secret-free. Real history comes from SQLite in
 * Milestone 02/03 (PLA-179/188); these feed the primitives during UI work.
 */

import type { Severity } from "@/lib/types";

/** Deterministic pseudo-noise in [0,1) from an integer index. */
function wobble(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export type ActivityLevel = "empty" | "light" | "high";

export interface ThroughputPoint {
  t: number;
  bps: number;
}

/** Aggregate transfer throughput over the recent window. */
export function throughputSeries(opts: {
  now: number;
  points?: number;
  intervalMs?: number;
  level?: ActivityLevel;
}): ThroughputPoint[] {
  const { now, points = 40, intervalMs = 90_000, level = "light" } = opts;
  const base = level === "empty" ? 0 : level === "high" ? 40_000_000 : 3_000_000;

  return Array.from({ length: points }, (_, i) => {
    const t = now - (points - 1 - i) * intervalMs;
    if (level === "empty") return { t, bps: 0 };
    const shape = 0.6 + 0.4 * Math.sin(i / 6);
    const noise = 0.75 + 0.5 * wobble(i);
    return { t, bps: Math.max(0, Math.round(base * shape * noise)) };
  });
}

export interface StoragePoolSeed {
  name: string;
  endBytes: number;
  totalBytes: number;
}

export type StorageTrendRow = { t: number } & Record<string, number>;

/**
 * Multi-series storage trend: used bytes per pool over `days`, gently rising to
 * each pool's current value. Returns Recharts-friendly flat rows keyed by pool
 * name. `level: "empty"` yields no rows (missing-data state).
 */
export function storageTrendSeries(opts: {
  now: number;
  days?: number;
  pools: StoragePoolSeed[];
  level?: ActivityLevel;
}): StorageTrendRow[] {
  const { now, days = 30, pools, level = "light" } = opts;
  if (level === "empty" || pools.length === 0) return [];

  const DAY = 86_400_000;
  return Array.from({ length: days }, (_, i) => {
    const t = now - (days - 1 - i) * DAY;
    const row = { t } as StorageTrendRow;
    for (const pool of pools) {
      // Rise from ~88% of current to current, with a small deterministic wobble.
      const progress = i / (days - 1);
      const drift = 1 - 0.12 * (1 - progress);
      const noise = 1 + (wobble(i + pool.name.length) - 0.5) * 0.01;
      row[pool.name] = Math.round(pool.endBytes * drift * noise);
    }
    return row;
  });
}

export interface EventBucket {
  t: number;
  count: number;
  severity: Severity;
}

/**
 * Event-density buckets for the health timeline strip: one bucket per hour over
 * `hours`, each with a count and the worst severity seen. `level` scales
 * density; "empty" yields all-zero buckets (still renders as a calm strip).
 */
export function eventBuckets(opts: {
  now: number;
  hours?: number;
  level?: ActivityLevel;
}): EventBucket[] {
  const { now, hours = 24, level = "light" } = opts;
  const HOUR = 3_600_000;
  const density = level === "empty" ? 0 : level === "high" ? 6 : 2;

  return Array.from({ length: hours }, (_, i) => {
    const t = now - (hours - 1 - i) * HOUR;
    if (density === 0) return { t, count: 0, severity: "info" as Severity };
    const count = Math.round(wobble(i) * density);
    // Occasional warning/critical spikes, deterministic by index.
    const severity: Severity =
      count === 0
        ? "info"
        : i % 11 === 0
          ? "critical"
          : i % 5 === 0
            ? "warning"
            : "info";
    return { t, count, severity };
  });
}
