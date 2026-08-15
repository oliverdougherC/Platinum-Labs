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
 *   flow intensity  quick attack / slow release  τ ≈ 0.9 s / 5 s
 *   service active  subtle fade                  τ ≈ 2.2 s
 *
 * Pure TS; the React host owns the clock.
 */

import { Ema } from "@/lib/topology/smoothing";
import type { SceneModel } from "@/lib/scene/model";
import type { FlowState } from "@/lib/topology/activity";

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
  flowAttack: 900,
  flowRelease: 5_000,
} as const;

export interface LiveFlow {
  flow: FlowState;
  /** Smoothed 0..1 intensity; flows ease out instead of vanishing. */
  intensity: number;
  /** False once the model stopped reporting this flow (easing out). */
  present: boolean;
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

  rxNorm = 0;
  txNorm = 0;
  private rxEma = new Ema(TAU.network);
  private txEma = new Ema(TAU.network);

  private storageFill = new Map<string, Ema>();
  private storageIo = new Map<string, Envelope>();
  private serviceGlow = new Map<string, Ema>();
  private flows = new Map<string, { env: Envelope; flow: FlowState; present: boolean }>();

  private model: SceneModel | null = null;

  /** Latest model becomes the target state. Call on every telemetry update. */
  applyModel(model: SceneModel): void {
    this.model = model;
    const seen = new Set(model.flows.map((f) => f.id));
    for (const f of model.flows) {
      const entry = this.flows.get(f.id);
      if (entry) {
        entry.flow = f;
        entry.present = true;
      } else {
        this.flows.set(f.id, {
          env: new Envelope(TAU.flowAttack, TAU.flowRelease),
          flow: f,
          present: true,
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
    for (let i = 0; i < cores.length; i++) {
      this.perCore[i] = this.perCoreEma[i]!.update(cores[i]!, nowMs);
    }
    this.totalLoad = this.totalLoadEma.update(m.core.totalFraction ?? 0, nowMs);
    this.memFraction =
      m.core.memFraction === null ? null : this.memEma.update(m.core.memFraction, nowMs);

    // Network normalized against a gigabit-ish full scale, log-free (the rim
    // treatment is subtle; flows carry the log scale).
    const full = 120_000_000;
    this.rxNorm = this.rxEma.update(Math.min(1, (m.network.rxBps ?? 0) / full), nowMs);
    this.txNorm = this.txEma.update(Math.min(1, (m.network.txBps ?? 0) / full), nowMs);

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
      io.update(ioIntensity(pool.readBps + pool.writeBps), nowMs);
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
      const v = entry.env.update(entry.present ? entry.flow.intensity : 0, nowMs);
      if (!entry.present && v < 0.012) this.flows.delete(id);
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
      const intensity = entry.env.current() ?? 0;
      if (intensity > 0.008) {
        out.push({ flow: entry.flow, intensity, present: entry.present });
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
  if (!Number.isFinite(bps) || bps < 250_000) return 0;
  const t = (Math.log10(bps) - Math.log10(250_000)) / (Math.log10(200_000_000) - Math.log10(250_000));
  return Math.max(0.06, Math.min(1, t));
}
