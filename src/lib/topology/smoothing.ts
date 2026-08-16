/**
 * Telemetry smoothing + throughput mapping for the living topology
 * (PLA-266/267) — pure, tested.
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

/**
 * Data-plane flow deadband: protocol chatter below this never draws an active
 * tunnel. Deliberately low (16 KB/s) so a genuinely slow transfer still shows
 * one patient packet rather than nothing; hysteresis lives in the motion
 * system's slow release, not here.
 */
export const FLOW_DEADBAND_BPS = 16_000;

/** Local pool-I/O shimmer keeps a higher floor: background writes are noise. */
export const POOL_IO_DEADBAND_BPS = 250_000;

/**
 * Throughput → tunnel core width, in world units (≈ CSS px at 1920×1080).
 * Piecewise-linear in log10 space through perceptual anchors (spec: low
 * traffic ≈ 1.5–2.5 px, moderate ≈ 4–7 px, very high ≈ 9–13 px, clamped so a
 * busy transfer can never consume the composition). Monotonic by construction;
 * below the deadband the tunnel does not exist (0).
 */
const WIDTH_ANCHORS: Array<[bps: number, width: number]> = [
  [FLOW_DEADBAND_BPS, 1.5],
  [100_000, 2.2],
  [1_000_000, 3.6],
  [10_000_000, 6.4],
  [100_000_000, 9.6],
  [1_000_000_000, 12.5],
];

export const FLOW_WIDTH_MAX = WIDTH_ANCHORS[WIDTH_ANCHORS.length - 1]![1];

export function widthFromRate(bps: number | null): number {
  if (bps === null || !Number.isFinite(bps) || bps < FLOW_DEADBAND_BPS) return 0;
  const x = Math.log10(bps);
  for (let i = 1; i < WIDTH_ANCHORS.length; i++) {
    const [b1, w1] = WIDTH_ANCHORS[i]!;
    if (bps <= b1) {
      const [b0, w0] = WIDTH_ANCHORS[i - 1]!;
      const t = (x - Math.log10(b0)) / (Math.log10(b1) - Math.log10(b0));
      return w0 + (w1 - w0) * t;
    }
  }
  return FLOW_WIDTH_MAX;
}

/**
 * Throughput → 0..1 intensity used for glow/particle scaling, log-scaled
 * between the flow deadband and `fullBps`. Below the deadband → exactly 0.
 */
export function intensityFromRate(
  bps: number,
  fullBps = 200_000_000,
  floorBps = FLOW_DEADBAND_BPS,
): number {
  if (!Number.isFinite(bps) || bps < floorBps) return 0;
  const logFloor = Math.log10(floorBps);
  const logFull = Math.log10(fullBps);
  return clamp((Math.log10(bps) - logFloor) / (logFull - logFloor), 0.05, 1);
}

/**
 * Particle cadence: seconds between packet arrivals at a fixed point of the
 * tunnel. Slow single packets at low rates, a steady (but never frantic)
 * stream at high rates.
 */
export function particlePeriodSeconds(bps: number): number {
  const i = intensityFromRate(bps);
  if (i <= 0) return Number.POSITIVE_INFINITY;
  // 6s between packets at the deadband → 0.55s at full scale.
  return 6 - 5.45 * i;
}
