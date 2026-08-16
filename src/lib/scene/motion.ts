/**
 * Motion system (PLA-266 rebuild) — telemetry smoothing decoupled from both
 * the polling cadence and the frame rate.
 *
 * Telemetry updates set TARGET values; every rendered frame advances CURRENT
 * values toward targets with per-channel time constants. The 2-second poll
 * cadence must be unobservable in the output (spec §10):
 *
 *   CPU corona      responsive but smooth        τ ≈ 1.4 s
 *   memory halo     very slow                    τ ≈ 9 s
 *   storage fill    extremely slow               τ ≈ 30 s
 *   network         relatively responsive        τ ≈ 1.6 s
 *   flow channels   quick attack / slow release  τ ≈ 0.4 s / 2.2 s
 *   service active  subtle fade                  τ ≈ 2.2 s
 *
 * Flow channels smooth the WIDTH (log-domain of the rate), so a 5.1 → 5.3 MB/s
 * polling wiggle is invisible while a real ramp reads within half a second.
 * Honesty gates live here too: stale host telemetry freezes its displayed
 * values, stale flows retain only a dim non-excited ghost, removed flows
 * release, and unknown rates never produce width.
 *
 * Pure TS; the React host owns the clock.
 */

import { Ema, POOL_IO_DEADBAND_BPS, widthFromRate } from "@/lib/topology/smoothing";
import type { SceneModel } from "@/lib/scene/model";
import type { FlowObservation } from "@/lib/topology/activity";

/** An EMA with separate attack (rising) and release (falling) time constants. */
export class Envelope {
  private value: number | null = null;
  private lastAt: number | null = null;

  constructor(
    private readonly attackTauMs: number,
    private readonly releaseTauMs: number,
  ) {}

  update(target: number, atMs: number): number {
    if (this.value === null || this.lastAt === null || atMs <= this.lastAt) {
      this.value = target;
      this.lastAt = atMs;
      return target;
    }
    const tau = target > this.value ? this.attackTauMs : this.releaseTauMs;
    const dt = atMs - this.lastAt;
    const alpha = 1 - Math.exp(-dt / tau);
    this.value = this.value + (target - this.value) * alpha;
    this.lastAt = atMs;
    return this.value;
  }

  current(): number | null {
    return this.value;
  }
}

const TAU = {
  core: 1_400,
  memory: 9_000,
  storage: 30_000,
  network: 1_600,
  service: 2_200,
  flowAttack: 400,
  flowRelease: 2_200,
  presenceAttack: 700,
  presenceRelease: 2_600,
} as const;

export interface LiveFlow {
  obs: FlowObservation;
  /** False once the model stopped reporting this flow (easing out). */
  present: boolean;
  /** Smoothed tunnel core width for the forward channel, world units. */
  forwardWidth: number;
  /** Smoothed tunnel core width for the reverse channel, world units. */
  reverseWidth: number;
  /** max(forward, reverse) — the conduit body width. */
  width: number;
  /** 0..1 presence envelope: state-only signals + glow scaling use this. */
  activity: number;
}

interface FlowEntry {
  obs: FlowObservation;
  present: boolean;
  forward: Envelope;
  reverse: Envelope;
  presence: Envelope;
}

function channelRate(
  obs: FlowObservation,
  direction: "forward" | "reverse",
): number | null {
  let sum: number | null = null;
  for (const ch of obs.channels) {
    if (ch.direction !== direction || ch.bytesPerSecond === null) continue;
    sum = (sum ?? 0) + ch.bytesPerSecond;
  }
  return sum;
}

function held(current: number | null, fallback: number): number {
  return current ?? fallback;
}

/** Conservative 10 GbE fallback when the operator has not declared a link. */
export const UNKNOWN_LINK_BYTES_PER_SECOND = 1_250_000_000;

/**
 * Stable aperture energy against configured link capacity. Square-root easing
 * keeps low traffic visible without saturating ordinary multi-gigabit bursts;
 * SceneMotion's EMA provides the temporal smoothing.
 */
export function networkIntensity(
  rateBytesPerSecond: number | null,
  linkBytesPerSecond: number | null,
): number {
  if (
    rateBytesPerSecond === null ||
    !Number.isFinite(rateBytesPerSecond) ||
    rateBytesPerSecond <= 0
  ) return 0;
  const capacity =
    linkBytesPerSecond !== null &&
    Number.isFinite(linkBytesPerSecond) &&
    linkBytesPerSecond > 0
      ? linkBytesPerSecond
      : UNKNOWN_LINK_BYTES_PER_SECOND;
  return Math.min(1, Math.sqrt(rateBytesPerSecond / capacity));
}

/**
 * All smoothed visual state. `applyModel` sets targets; `advance` moves the
 * current values and returns nothing — read the public fields after it.
 */
export class SceneMotion {
  perCore: number[] = [];
  private perCoreEma: Ema[] = [];

  totalLoad = 0;
  private totalLoadEma = new Ema(TAU.core);

  /** 0..1 or null while unknown. */
  memFraction: number | null = null;
  private memEma = new Ema(TAU.memory);

  gpuLoad = 0;
  private gpuEma = new Ema(TAU.core);

  rxNorm = 0;
  txNorm = 0;
  private rxEma = new Ema(TAU.network);
  private txEma = new Ema(TAU.network);

  private storageFill = new Map<string, Ema>();
  private storageIo = new Map<string, Envelope>();
  private serviceGlow = new Map<string, Ema>();
  private flows = new Map<string, FlowEntry>();

  private model: SceneModel | null = null;

  /** Latest model becomes the target state. Call on every telemetry update. */
  applyModel(model: SceneModel): void {
    this.model = model;
    const seen = new Set(model.flows.map((f) => f.id));
    for (const f of model.flows) {
      const entry = this.flows.get(f.id);
      if (entry) {
        entry.obs = f;
        entry.present = true;
      } else {
        this.flows.set(f.id, {
          obs: f,
          present: true,
          forward: new Envelope(TAU.flowAttack, TAU.flowRelease),
          reverse: new Envelope(TAU.flowAttack, TAU.flowRelease),
          presence: new Envelope(TAU.presenceAttack, TAU.presenceRelease),
        });
      }
    }
    for (const [id, entry] of this.flows) {
      if (!seen.has(id)) entry.present = false;
    }
  }

  /** Advance every channel toward its target. Call once per rendered frame. */
  advance(nowMs: number): void {
    const m = this.model;
    if (!m) return;

    const cores = m.core.perCore;
    if (this.perCoreEma.length !== cores.length) {
      this.perCoreEma = cores.map(() => new Ema(TAU.core));
      this.perCore = new Array(cores.length).fill(0);
    }
    const coreLive = m.core.status === "available";
    const coreFrozen = m.core.status === "stale";
    for (let i = 0; i < cores.length; i++) {
      const current = this.perCoreEma[i]!.current();
      const target = coreFrozen ? held(current, cores[i]!) : coreLive ? cores[i]! : 0;
      this.perCore[i] = this.perCoreEma[i]!.update(target, nowMs);
    }
    this.totalLoad = this.totalLoadEma.update(
      coreFrozen
        ? held(this.totalLoadEma.current(), m.core.totalFraction ?? 0)
        : coreLive
          ? (m.core.totalFraction ?? 0)
          : 0,
      nowMs,
    );
    this.memFraction =
      m.core.memFraction === null ? null : this.memEma.update(m.core.memFraction, nowMs);
    this.gpuLoad = this.gpuEma.update(
      coreFrozen
        ? held(this.gpuEma.current(), m.core.gpuFraction ?? 0)
        : (m.core.gpuFraction ?? 0),
      nowMs,
    );

    // Normalize against the operator-declared link capacity. An unknown link
    // uses a conservative 10 GbE visual fallback (without claiming metadata).
    const networkLive = m.network.status === "available";
    this.rxNorm = this.rxEma.update(
      networkLive
        ? networkIntensity(m.network.rxBps, m.network.linkBytesPerSecond)
        : 0,
      nowMs,
    );
    this.txNorm = this.txEma.update(
      networkLive
        ? networkIntensity(m.network.txBps, m.network.linkBytesPerSecond)
        : 0,
      nowMs,
    );

    for (const pool of m.storage) {
      let fill = this.storageFill.get(pool.name);
      if (!fill) {
        fill = new Ema(TAU.storage);
        this.storageFill.set(pool.name, fill);
      }
      fill.update(pool.capacityFraction, nowMs);
      let io = this.storageIo.get(pool.name);
      if (!io) {
        io = new Envelope(TAU.flowAttack, TAU.flowRelease);
        this.storageIo.set(pool.name, io);
      }
      // Surface I/O shimmer may only follow LIVE telemetry. Stale or
      // unavailable I/O releases to darkness — last-known values must not
      // keep the body glittering as though current (PLA-273).
      const ioTarget =
        pool.ioFreshness === "live"
          ? ioIntensity((pool.readBps ?? 0) + (pool.writeBps ?? 0))
          : 0;
      io.update(ioTarget, nowMs);
    }

    for (const s of m.services) {
      let glow = this.serviceGlow.get(s.id);
      if (!glow) {
        glow = new Ema(TAU.service);
        this.serviceGlow.set(s.id, glow);
      }
      glow.update(s.active ? 1 : 0, nowMs);
    }

    for (const [id, entry] of this.flows) {
      const { obs, present } = entry;
      const live = present && obs.freshness === "live";
      const stale = present && obs.freshness === "stale";
      // Width targets: data-plane channels with known rates only. A stale
      // flow holds its last body geometry as a dim, frozen ghost; a removed
      // flow releases. Excitation is gated separately in the renderer.
      const fTarget = !present
        ? 0
        : obs.plane !== "data"
          ? 0
          : widthFromRate(channelRate(obs, "forward"));
      const rTarget = !present
        ? 0
        : obs.plane !== "data"
          ? 0
          : widthFromRate(channelRate(obs, "reverse"));
      entry.forward.update(stale ? held(entry.forward.current(), fTarget) : fTarget, nowMs);
      entry.reverse.update(stale ? held(entry.reverse.current(), rTarget) : rTarget, nowMs);
      const presence = entry.presence.update(live ? 1 : stale ? 0.4 : 0, nowMs);
      if (!present && presence < 0.01 && (entry.forward.current() ?? 0) < 0.05) {
        this.flows.delete(id);
      }
    }
  }

  storageFillOf(name: string): number | null {
    return this.storageFill.get(name)?.current() ?? null;
  }

  storageIoOf(name: string): number {
    return this.storageIo.get(name)?.current() ?? 0;
  }

  serviceGlowOf(id: string): number {
    return this.serviceGlow.get(id)?.current() ?? 0;
  }

  liveFlows(): LiveFlow[] {
    const out: LiveFlow[] = [];
    for (const entry of this.flows.values()) {
      const forwardWidth = entry.forward.current() ?? 0;
      const reverseWidth = entry.reverse.current() ?? 0;
      const activity = entry.presence.current() ?? 0;
      if (forwardWidth > 0.05 || reverseWidth > 0.05 || activity > 0.02) {
        out.push({
          obs: entry.obs,
          present: entry.present,
          forwardWidth,
          reverseWidth,
          width: Math.max(forwardWidth, reverseWidth),
          activity,
        });
      }
    }
    return out;
  }

  /** Jump every channel straight to its target (frozen/reduced-motion render). */
  snapToTargets(nowMs: number): void {
    // Two far-apart updates collapse the EMA onto the target.
    this.advance(nowMs);
    this.advance(nowMs + 1e9);
    // Re-anchor the clock so a later live resume does not see a huge gap.
    this.advance(nowMs + 1e9 + 1);
  }
}

/** Log-scaled 0..1 for pool I/O shimmer (250 kB/s deadband → ~200 MB/s full). */
export function ioIntensity(bps: number): number {
  if (!Number.isFinite(bps) || bps < POOL_IO_DEADBAND_BPS) return 0;
  const t =
    (Math.log10(bps) - Math.log10(POOL_IO_DEADBAND_BPS)) /
    (Math.log10(200_000_000) - Math.log10(POOL_IO_DEADBAND_BPS));
  return Math.max(0.06, Math.min(1, t));
}
