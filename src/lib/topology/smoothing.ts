/**
 * Telemetry smoothing for the living topology (PLA-266/267) — pure, tested.
 *
 * Raw Linux utilization jitters at polling frequency; a living display should
 * breathe. Every animated visual channel passes through an exponential moving
 * average with a time constant, plus deadbands/log mapping so 1 KB/s background
 * noise never becomes visible drama.
 */

import { clamp } from "@/lib/utils";

/**
 * Time-aware exponential moving average. `tauMs` is the time constant: after
 * tau ms the value has moved ~63% toward the target regardless of sample
 * spacing (correct for irregular SSE arrival).
 */
export class Ema {
  private value: number | null = null;
  private lastAt: number | null = null;

  constructor(private readonly tauMs: number) {}

  update(target: number, atMs: number): number {
    if (this.value === null || this.lastAt === null || atMs <= this.lastAt) {
      this.value = target;
      this.lastAt = atMs;
      return target;
    }
    const dt = atMs - this.lastAt;
    const alpha = 1 - Math.exp(-dt / this.tauMs);
    this.value = this.value + (target - this.value) * alpha;
    this.lastAt = atMs;
    return this.value;
  }

  current(): number | null {
    return this.value;
  }

  reset(): void {
    this.value = null;
    this.lastAt = null;
  }
}

/** Values below the floor are treated as zero (noise deadband). */
export function deadband(value: number, floor: number): number {
  return value < floor ? 0 : value;
}

/** Ignore background chatter below this when animating network/disk flows. */
export const FLOW_DEADBAND_BPS = 250_000; // 250 kB/s

/**
 * Map a byte rate onto a 0..1 visual intensity, log-scaled between the
 * deadband floor and `fullBps` (default 80 MB/s ≈ saturated gigabit-ish).
 * Below the deadband → exactly 0 (no motion for background noise).
 */
export function intensityFromRate(
  bps: number,
  fullBps = 80_000_000,
  floorBps = FLOW_DEADBAND_BPS,
): number {
  if (!Number.isFinite(bps) || bps < floorBps) return 0;
  const logFloor = Math.log10(floorBps);
  const logFull = Math.log10(fullBps);
  return clamp((Math.log10(bps) - logFloor) / (logFull - logFloor), 0.05, 1);
}

/**
 * Flow-dash animation duration (seconds) for an intensity: calm at low
 * intensity (slow drift), never frantic at high intensity. Infinity (no
 * animation) at zero intensity.
 */
export function flowDurationSeconds(intensity: number): number {
  if (intensity <= 0) return Number.POSITIVE_INFINITY;
  // 14s crawl at minimum intensity → 3.5s at full. Deliberately slow.
  return 14 - 10.5 * clamp(intensity, 0, 1);
}
