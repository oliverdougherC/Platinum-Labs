/**
 * Storage capacity projection (PLA-188).
 *
 * Pure and isomorphic. Turns noisy intraday storage samples into a defensible
 * "estimated to reach N%" date using a robust, understandable method:
 *
 *   1. reduce samples to one representative value per UTC day (the daily MEDIAN,
 *      which is insensitive to within-day spikes / a transient ingest burst),
 *   2. require a minimum amount of history before projecting at all,
 *   3. ignore history before the most recent large discontinuity (a big deletion
 *      or pool replacement makes older growth meaningless),
 *   4. estimate the growth rate with the Theil–Sen slope (the median of all
 *      pairwise slopes) — robust to outliers, unlike least-squares,
 *   5. only project when growth is positive and the estimate is not absurd
 *      (too-far-out estimates are hidden rather than presented as prophecy).
 *
 * The result is deliberately conservative: when in doubt it returns no
 * projection, and the UI presents any estimate as subordinate ("~", "estimated").
 */

const DAY = 86_400_000;

export interface StoragePoint {
  t: number;
  usedBytes: number;
}

export interface ProjectionOptions {
  totalBytes: number;
  now: number;
  /** Capacity fraction to project toward (default 0.8). */
  thresholdFraction?: number;
  /** Minimum distinct days of history required to project (default 7). */
  minDays?: number;
  /** A day-over-day drop larger than this fraction of total resets the window. */
  discontinuityFraction?: number;
  /** Hide estimates beyond this many days as unreliable (default ~5 years). */
  maxProjectionDays?: number;
}

export interface DailyPoint {
  /** UTC day boundary (epoch ms, floored to DAY). */
  day: number;
  usedBytes: number;
}

export interface CapacityProjection {
  thresholdFraction: number;
  etaDays: number;
  etaAt: number;
}

export interface ProjectionResult {
  dailyMedians: DailyPoint[];
  /** Robust growth estimate in bytes/day over the effective window, or null. */
  slopeBytesPerDay: number | null;
  /** Net change over the last ~30 days of daily medians, or null if too short. */
  growth30dBytes: number | null;
  /** Present only when growth is positive and the estimate is trustworthy. */
  projection: CapacityProjection | null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Collapse raw samples into one median value per UTC day, ascending. */
export function dailyMedians(points: StoragePoint[]): DailyPoint[] {
  const byDay = new Map<number, number[]>();
  for (const p of points) {
    const day = Math.floor(p.t / DAY) * DAY;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(p.usedBytes);
  }
  return [...byDay.entries()]
    .map(([day, vals]) => ({ day, usedBytes: median(vals) }))
    .sort((a, b) => a.day - b.day);
}

/** Theil–Sen slope (bytes/day): the median of all pairwise slopes. */
export function theilSenSlope(daily: DailyPoint[]): number | null {
  if (daily.length < 2) return null;
  const slopes: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    for (let j = i + 1; j < daily.length; j++) {
      const dDays = (daily[j]!.day - daily[i]!.day) / DAY;
      if (dDays <= 0) continue;
      slopes.push((daily[j]!.usedBytes - daily[i]!.usedBytes) / dDays);
    }
  }
  return slopes.length ? median(slopes) : null;
}

/**
 * Trim the daily series to the segment after the most recent large drop, so a
 * deletion/pool-replacement doesn't corrupt the growth estimate.
 */
function afterLastDiscontinuity(daily: DailyPoint[], dropBytes: number): DailyPoint[] {
  let start = 0;
  for (let i = 1; i < daily.length; i++) {
    if (daily[i - 1]!.usedBytes - daily[i]!.usedBytes > dropBytes) start = i;
  }
  return daily.slice(start);
}

export function projectCapacity(
  points: StoragePoint[],
  opts: ProjectionOptions,
): ProjectionResult {
  const thresholdFraction = opts.thresholdFraction ?? 0.8;
  const minDays = opts.minDays ?? 7;
  const discontinuityFraction = opts.discontinuityFraction ?? 0.15;
  const maxProjectionDays = opts.maxProjectionDays ?? 5 * 365;

  const allDaily = dailyMedians(points);

  // 30-day growth (informational) uses the full series where available.
  let growth30dBytes: number | null = null;
  if (allDaily.length >= 2) {
    const cutoff = opts.now - 30 * DAY;
    const recent = allDaily.filter((d) => d.day >= cutoff);
    const ref = recent.length >= 2 ? recent : allDaily;
    growth30dBytes = ref[ref.length - 1]!.usedBytes - ref[0]!.usedBytes;
  }

  const daily = afterLastDiscontinuity(
    allDaily,
    discontinuityFraction * opts.totalBytes,
  );

  if (daily.length < minDays) {
    return { dailyMedians: allDaily, slopeBytesPerDay: null, growth30dBytes, projection: null };
  }

  const slope = theilSenSlope(daily);
  if (slope === null || slope <= 0) {
    // Not filling (flat or shrinking) — no threshold date to predict.
    return { dailyMedians: allDaily, slopeBytesPerDay: slope, growth30dBytes, projection: null };
  }

  const currentUsed = daily[daily.length - 1]!.usedBytes;
  const thresholdBytes = opts.totalBytes * thresholdFraction;
  if (currentUsed >= thresholdBytes) {
    // Already past the threshold — the alert engine owns that, not a forecast.
    return { dailyMedians: allDaily, slopeBytesPerDay: slope, growth30dBytes, projection: null };
  }

  const etaDays = (thresholdBytes - currentUsed) / slope;
  if (!Number.isFinite(etaDays) || etaDays <= 0 || etaDays > maxProjectionDays) {
    return { dailyMedians: allDaily, slopeBytesPerDay: slope, growth30dBytes, projection: null };
  }

  return {
    dailyMedians: allDaily,
    slopeBytesPerDay: slope,
    growth30dBytes,
    projection: {
      thresholdFraction,
      etaDays,
      etaAt: opts.now + etaDays * DAY,
    },
  };
}

/** Human phrasing for the (subordinate) projection line. */
export function projectionLabel(p: CapacityProjection): string {
  const pct = Math.round(p.thresholdFraction * 100);
  const days = Math.round(p.etaDays);
  if (days < 45) return `Estimated to reach ${pct}% in ~${days} days`;
  const months = Math.round(p.etaDays / 30);
  if (months < 24) return `Estimated to reach ${pct}% in ~${months} months`;
  return `Estimated to reach ${pct}% in ~${Math.round(p.etaDays / 365)} years`;
}
