/**
 * V4 Kinetic Flow Canvas — the kinetic engine.
 *
 * Owns everything that must survive React: one monotonic visual clock for the
 * lifetime of the mounted stage, per-flow phase identity, and the eased
 * visual state that sits between truth and pixels. React (and the telemetry
 * transport behind it) only ever moves TARGETS; the engine moves what is on
 * screen toward them. That separation is the product requirement: a 2-second
 * snapshot update may change what the scene should look like, but it must
 * never reset animation phase, teleport particles, snap ribbon widths, or
 * shift geometry.
 *
 * Truth vs visual state: `KineticScene` says "rate is 31.2 MB/s now";
 * a `FlowVisual` says "currently easing from the previous appearance toward
 * that target". Easing never alters the semantic value — text surfaces read
 * the scene, light reads the visuals.
 *
 * The engine is pure TypeScript with an injected clock (milliseconds), which
 * is what makes phase continuity unit-testable.
 */

import type {
  AnchorModel,
  FieldCellModel,
  KineticFlow,
  KineticScene,
  StorageStratumModel,
} from "./model";
import { rateIntensity } from "./model";
import type { KineticLayout, SampledPath } from "./layout";
import { hash01 } from "./layout";
import {
  FLOW_DEADBAND_BPS,
  particlePeriodSeconds,
} from "@/lib/topology/smoothing";

// --- timing constants ---------------------------------------------------------

/** Fixed particle speed in px/s — velocity never encodes rate. */
export const PARTICLE_SPEED = 86;
/** Bounded particle pool per flow channel. Never exceeded. */
export const MAX_PARTICLE_SLOTS = 42;
/** Flow onset: a new real flow energizes in over this long. */
export const ONSET_SECONDS = 0.9;
/** Flow decay: a stopped flow releases over this long. */
export const DECAY_SECONDS = 0.7;
/**
 * Per-frame delta clamp. A hidden tab, sleeping laptop, or 30-second
 * scheduling pause resumes as ONE bounded step — no particle can cross the
 * stage on a giant delta, and no easing can explode. Visual time simply does
 * not pass while frames are not being produced.
 */
export const MAX_FRAME_DELTA_SECONDS = 0.1;

/** Exponential-approach time constants (seconds). Ease-out, no overshoot. */
const TAU = {
  /** Throughput magnitude → ribbon width / particle density / glow energy. */
  rate: 0.28,
  /** Treatment crossfades (live/state-only/stale/zero layers). */
  treatment: 0.2,
  /** Individual particle-slot fade in/out. */
  slot: 0.16,
  /** Selection dimming on canvas (DOM uses a matching CSS transition). */
  dim: 0.12,
  /** Workload cell brightness / halo / radius; anchor glow; storage wake. */
  telemetry: 0.45,
  /** Treemap redistribution settles inside the normal two-second sample. */
  geometry: 0.32,
  /** Storage fill level (changes rarely; a slow liquid settle). */
  fill: 0.9,
} as const;

const SETTLE_EPS = 0.004;
const MEMORY_ABSOLUTE_DEADBAND_BYTES = 2 * 1024 ** 2;
const MEMORY_RELATIVE_DEADBAND = 0.005;

function approach(current: number, target: number, dt: number, tau: number): number {
  const next = current + (target - current) * (1 - Math.exp(-dt / tau));
  return Math.abs(next - target) < SETTLE_EPS ? target : next;
}

function approachMemory(current: number, target: number, dt: number): number {
  const next = current + (target - current) * (1 - Math.exp(-dt / TAU.geometry));
  const epsilon = Math.max(MEMORY_ABSOLUTE_DEADBAND_BYTES / 4, target * 0.005);
  return Math.abs(next - target) < epsilon ? target : next;
}

function memoryTarget(previous: number, next: number): number {
  const delta = Math.abs(next - previous);
  const threshold = Math.max(
    MEMORY_ABSOLUTE_DEADBAND_BYTES,
    Math.max(previous, next) * MEMORY_RELATIVE_DEADBAND,
  );
  return delta < threshold ? previous : next;
}

/** Rate easing runs in log10 space so decade jumps feel proportional. */
function approachRate(current: number, target: number, dt: number): number {
  if (current === target) return target;
  const lc = Math.log10(Math.max(current, 1));
  const lt = Math.log10(Math.max(target, 1));
  const next = approach(lc, lt, dt, TAU.rate);
  return next === lt ? target : Math.pow(10, next);
}

const GOLDEN = 0.618033988749895;

const frac = (v: number): number => v - Math.floor(v);

// --- visual state shapes --------------------------------------------------------

export interface ChannelVisual {
  direction: "forward" | "reverse";
  /** Stable phase seed from (flow id, channel direction) — never random. */
  seed: number;
  /** Eased bytes/sec driving density and particle size. */
  rate: number;
  /** Per-slot visibility 0..1; index order is spatially interleaved. */
  slotAlphas: number[];
}

export interface FlowVisual {
  id: string;
  /** Latest truth (or last-known truth while decaying). */
  flow: KineticFlow;
  path: SampledPath;
  /** Onset/decay envelope 0..1. Reappearance simply reverses its direction. */
  presence: number;
  /** True while the flow has left the truth model and is releasing. */
  removed: boolean;
  /** Treatment layer weights — crossfade, never snap. */
  liveness: number;
  breath: number;
  staleW: number;
  zeroW: number;
  /** Eased headline rate for ribbon width / wake energy. */
  rate: number;
  dim: number;
  channels: ChannelVisual[];
}

export interface CellVisual {
  id: string;
  cell: FieldCellModel;
  /** Eased raw memory bytes. The painter repacks these weights every frame. */
  weight: number;
  intensity: number;
  halo: number;
  /** Crossfade toward the unknown (dashed ring) treatment. */
  unknownW: number;
  attentionW: number;
  /** Membership fade: new cells rise in, removed cells release. */
  alpha: number;
  removed: boolean;
  dim: number;
}

export interface StratumVisual {
  name: string;
  pool: StorageStratumModel;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: number;
  io: number;
  scrubW: number;
  emberW: number;
  dim: number;
}

export interface AnchorVisual {
  id: AnchorModel["id"];
  model: AnchorModel;
  x: number;
  y: number;
  r: number;
  glow: number;
  active: boolean;
  dim: number;
}

export interface KineticSelectionRef {
  kind: "anchor" | "pool" | "cell" | "orchestrator" | "edge";
  id: string;
}

export interface KineticVisualState {
  flows: FlowVisual[];
  cells: CellVisual[];
  strata: StratumVisual[];
  anchors: AnchorVisual[];
}

// --- particle slots ---------------------------------------------------------------

/** Particle spacing along the path for a given rate (px between comets). */
export function slotSpacing(bps: number): number {
  const period = particlePeriodSeconds(bps);
  if (!Number.isFinite(period)) return Number.POSITIVE_INFINITY;
  return Math.min(Math.max(PARTICLE_SPEED * period, 30), 460);
}

/** How many of the bounded slots a rate justifies on a path. */
export function targetSlotCount(pathTotal: number, bps: number): number {
  if (!Number.isFinite(bps) || bps < FLOW_DEADBAND_BPS) return 0;
  const spacing = slotSpacing(bps);
  if (!Number.isFinite(spacing)) return 0;
  return Math.min(Math.ceil(pathTotal / spacing) + 1, MAX_PARTICLE_SLOTS);
}

/**
 * Normalized position (0..1 of arc length) of one particle slot at visual
 * time `t`. A low-discrepancy golden-ratio sequence keeps any visible prefix
 * of slots near-evenly distributed, so density changes only fade slots in and
 * out — the field never relocates. Travel is a pure function of absolute
 * time: phase can never reset on a data update.
 */
export function slotPosition(
  seed: number,
  slot: number,
  t: number,
  pathTotal: number,
): number {
  return frac(seed + slot * GOLDEN + (t * PARTICLE_SPEED) / Math.max(pathTotal, 1));
}

// --- selection relatedness ----------------------------------------------------------

function flowTouchesRef(flow: KineticFlow, sel: KineticSelectionRef): boolean {
  return [flow.from, flow.to].some((ref) => {
    if (sel.kind === "anchor") return ref.kind === "anchor" && ref.id === sel.id;
    if (sel.kind === "pool") return ref.kind === "pool" && ref.name === sel.id;
    if (sel.kind === "orchestrator") return ref.kind === "orchestrator" && ref.id === sel.id;
    if (sel.kind === "edge") return ref.kind === "edge" && ref.id === sel.id;
    return false;
  });
}

function memberDimTarget(
  selection: KineticSelectionRef | null,
  member: KineticSelectionRef,
  scene: KineticScene,
): number {
  if (!selection) return 1;
  if (selection.kind === member.kind && selection.id === member.id) return 1;
  const related = scene.flows.some(
    (flow) => flowTouchesRef(flow, selection) && flowTouchesRef(flow, member),
  );
  return related ? 1 : 0.22;
}

function flowDimTarget(
  selection: KineticSelectionRef | null,
  flow: KineticFlow,
): number {
  if (!selection) return 1;
  if (selection.kind === "cell") return 0.22;
  return flowTouchesRef(flow, selection) ? 1 : 0.16;
}

// --- engine -----------------------------------------------------------------------------

interface FlowTargets {
  presence: number;
  liveness: number;
  breath: number;
  staleW: number;
  zeroW: number;
  rate: number;
  dim: number;
  channelRates: number[];
  channelCounts: number[];
}

export class KineticEngine {
  /** Monotonic visual time in seconds. Only frames advance it; never resets. */
  private time: number;
  private lastFrameAt: number | null = null;

  private scene: KineticScene | null = null;
  private layout: KineticLayout | null = null;
  private selection: KineticSelectionRef | null = null;

  private flowVisuals = new Map<string, FlowVisual>();
  private flowTargets = new Map<string, FlowTargets>();
  private cellVisuals = new Map<string, CellVisual>();
  private cellTargets = new Map<
    string,
    { weight: number; intensity: number; halo: number; unknownW: number; attentionW: number; alpha: number; dim: number }
  >();
  private strataVisuals = new Map<string, StratumVisual>();
  private anchorVisuals = new Map<string, AnchorVisual>();

  /** Cached arrays handed to the painter — rebuilt on sync, not per frame. */
  private state: KineticVisualState = { flows: [], cells: [], strata: [], anchors: [] };
  private settledFlag = true;

  constructor(epochMs: number) {
    // The epoch is established exactly once for the lifetime of the mounted
    // stage. Everything downstream is relative visual time.
    this.time = 0;
    this.lastFrameAt = epochMs;
  }

  /** Current visual time (seconds). */
  now(): number {
    return this.time;
  }

  visualState(): KineticVisualState {
    return this.state;
  }

  setSelection(selection: KineticSelectionRef | null): void {
    this.selection = selection;
    if (this.scene && this.layout) this.applyTargets();
  }

  /**
   * Update TARGET state from a new scene/layout. Never touches visual time or
   * particle phase. Flows that left the truth model stay as decaying visuals
   * (their last path retained); a flow that returns mid-decay simply reverses
   * its envelope — one visual object, no duplicate populations.
   */
  syncTargets(scene: KineticScene, layout: KineticLayout, opts?: { snap?: boolean }): void {
    const stageChanged =
      this.layout !== null && (this.layout.w !== layout.w || this.layout.h !== layout.h);
    this.scene = scene;
    this.layout = layout;

    // A viewport change is an intentional geometry recompute: decaying
    // visuals hold stale coordinates, so they release immediately rather
    // than painting geometry from another stage size.
    if (stageChanged) {
      for (const [id, visual] of this.flowVisuals) {
        if (visual.removed) {
          this.flowVisuals.delete(id);
          this.flowTargets.delete(id);
        }
      }
      for (const [id, visual] of this.cellVisuals) {
        if (visual.removed) {
          this.cellVisuals.delete(id);
          this.cellTargets.delete(id);
        }
      }
    }

    this.syncFlows(scene, layout);
    this.syncCells(scene, layout);
    this.syncStrata(scene, layout);
    this.syncAnchors(scene, layout);
    this.applyTargets();
    this.rebuildStateArrays();
    // Conservatively unsettled: the next frame re-evaluates against the new
    // targets and re-parks immediately when nothing actually moved.
    this.settledFlag = false;
    if (opts?.snap) this.snap();
  }

  private syncFlows(scene: KineticScene, layout: KineticLayout): void {
    const pathById = new Map(layout.flows.map((f) => [f.id, f.path]));
    const present = new Set<string>();
    for (const flow of scene.flows) {
      const path = pathById.get(flow.id);
      if (!path) continue;
      present.add(flow.id);
      const existing = this.flowVisuals.get(flow.id);
      if (existing) {
        existing.flow = flow;
        existing.path = path;
        existing.removed = false;
      } else {
        this.flowVisuals.set(flow.id, {
          id: flow.id,
          flow,
          path,
          presence: 0,
          removed: false,
          liveness: 0,
          breath: 0,
          staleW: 0,
          zeroW: 0,
          rate: 0,
          dim: 1,
          channels: flow.channels.map((channel) => ({
            direction: channel.direction,
            seed: hash01(`${flow.id}:${channel.direction}`, 5),
            rate: 0,
            slotAlphas: new Array<number>(MAX_PARTICLE_SLOTS).fill(0),
          })),
        });
      }
      // Channel membership can genuinely change (download picks up a seed
      // channel); reconcile by direction, keeping existing slot state.
      const visual = this.flowVisuals.get(flow.id)!;
      const byDirection = new Map(visual.channels.map((c) => [c.direction, c]));
      visual.channels = flow.channels.map(
        (channel) =>
          byDirection.get(channel.direction) ?? {
            direction: channel.direction,
            seed: hash01(`${flow.id}:${channel.direction}`, 5),
            rate: 0,
            slotAlphas: new Array<number>(MAX_PARTICLE_SLOTS).fill(0),
          },
      );
    }
    for (const visual of this.flowVisuals.values()) {
      if (!present.has(visual.id)) visual.removed = true;
    }
  }

  private syncCells(scene: KineticScene, layout: KineticLayout): void {
    const cellById = new Map<string, FieldCellModel>();
    for (const group of scene.field) {
      for (const cell of group.cells) cellById.set(cell.id, cell);
    }
    const present = new Set<string>();
    for (const group of layout.groups) {
      for (const placed of group.cells) {
        const cell = cellById.get(placed.id);
        if (!cell) continue;
        present.add(placed.id);
        const existing = this.cellVisuals.get(placed.id);
        if (existing) {
          existing.cell = cell;
          existing.removed = false;
        } else {
          this.cellVisuals.set(placed.id, {
            id: placed.id,
            cell,
            // Entry begins as a truthful sliver of the measured weight; its
            // alpha and raw weight then rise together without a full-size pop.
            weight: placed.weight * 0.002,
            intensity: cell.intensity ?? 0,
            halo: 0,
            unknownW: cell.unverified || cell.intensity === null ? 1 : 0,
            attentionW: cell.attention ? 1 : 0,
            alpha: 0,
            removed: false,
            dim: 1,
          });
        }
        // A 0.5% / 2 MiB deadband prevents insignificant collector noise from
        // keeping a 24/7 surface in perpetual redistribution.
        const target = this.cellTargets.get(placed.id) ?? {
          weight: placed.weight,
          intensity: 0,
          halo: 0,
          unknownW: 0,
          attentionW: 0,
          alpha: 1,
          dim: 1,
        };
        target.weight = memoryTarget(target.weight, placed.weight);
        this.cellTargets.set(placed.id, target);
      }
    }
    for (const visual of this.cellVisuals.values()) {
      if (!present.has(visual.id)) {
        visual.removed = true;
        const target = this.cellTargets.get(visual.id);
        if (target) target.weight = 0;
      }
    }
  }

  private syncStrata(scene: KineticScene, layout: KineticLayout): void {
    const poolByName = new Map(scene.storage.map((s) => [s.name, s]));
    const present = new Set<string>();
    for (const placed of layout.strata) {
      const pool = poolByName.get(placed.name);
      if (!pool) continue;
      present.add(placed.name);
      const existing = this.strataVisuals.get(placed.name);
      if (existing) {
        existing.pool = pool;
        existing.x = placed.x;
        existing.y = placed.y;
        existing.w = placed.w;
        existing.h = placed.h;
      } else {
        this.strataVisuals.set(placed.name, {
          name: placed.name,
          pool,
          x: placed.x,
          y: placed.y,
          w: placed.w,
          h: placed.h,
          fill: Math.min(Math.max(pool.capacityFraction, 0), 1),
          io: 0,
          scrubW: pool.scrubbing ? 1 : 0,
          emberW: pool.healthy ? 0 : 1,
          dim: 1,
        });
      }
    }
    for (const name of [...this.strataVisuals.keys()]) {
      if (!present.has(name)) this.strataVisuals.delete(name);
    }
  }

  private syncAnchors(scene: KineticScene, layout: KineticLayout): void {
    const modelById = new Map(scene.anchors.map((a) => [a.id, a]));
    const present = new Set<string>();
    for (const placed of layout.anchors) {
      const model = modelById.get(placed.id);
      if (!model) continue;
      present.add(placed.id);
      const existing = this.anchorVisuals.get(placed.id);
      if (existing) {
        existing.model = model;
        existing.x = placed.x;
        existing.y = placed.y;
        existing.r = placed.r;
        existing.active = model.active;
      } else {
        this.anchorVisuals.set(placed.id, {
          id: placed.id,
          model,
          x: placed.x,
          y: placed.y,
          r: placed.r,
          glow: model.active ? 0.35 + model.glow * 0.65 : 0.16,
          active: model.active,
          dim: 1,
        });
      }
    }
    for (const id of [...this.anchorVisuals.keys()]) {
      if (!present.has(id)) this.anchorVisuals.delete(id);
    }
  }

  /** Recompute every numeric TARGET from current truth + selection. */
  private applyTargets(): void {
    const scene = this.scene;
    if (!scene) return;
    for (const visual of this.flowVisuals.values()) {
      const flow = visual.flow;
      const treatment = flow.treatment;
      const live = treatment === "particles";
      const targets: FlowTargets = {
        presence: visual.removed ? 0 : 1,
        liveness: live ? 1 : 0,
        breath: treatment === "state-only" ? 1 : 0,
        staleW: treatment === "stale" ? 1 : 0,
        zeroW: treatment === "confirmed-zero" ? 1 : 0,
        rate: live ? flow.rateBps ?? 0 : 0,
        dim: flowDimTarget(this.selection, flow),
        channelRates: visual.channels.map((channel) => {
          // Non-live treatments hold the last eased magnitude: the layer
          // weights carry the fade, so nothing shrinks through the width
          // curve on its way out.
          if (!live) return channel.rate;
          const truth = flow.channels.find((c) => c.direction === channel.direction);
          return truth?.bytesPerSecond ?? 0;
        }),
        channelCounts: [],
      };
      if (!live && visual.rate > 0) targets.rate = visual.rate;
      targets.channelCounts = visual.channels.map((_, i) =>
        live
          ? targetSlotCount(visual.path.total, targets.channelRates[i] ?? 0)
          : 0,
      );
      // First appearance of a live rate snaps magnitude (nothing meaningful
      // to ease FROM); afterwards magnitude eases.
      if (live && visual.liveness < 0.05 && visual.rate === 0) {
        visual.rate = targets.rate;
        visual.channels.forEach((channel, i) => {
          channel.rate = targets.channelRates[i] ?? 0;
        });
      }
      this.flowTargets.set(visual.id, targets);
    }
    for (const id of [...this.flowTargets.keys()]) {
      if (!this.flowVisuals.has(id)) this.flowTargets.delete(id);
    }

    for (const visual of this.cellVisuals.values()) {
      const target = this.cellTargets.get(visual.id);
      if (!target) continue;
      const cell = visual.cell;
      const unknown = cell.unverified || cell.intensity === null;
      target.intensity = unknown ? 0 : cell.intensity ?? 0;
      target.halo = cell.ioHalo;
      target.unknownW = unknown && !cell.attention ? 1 : 0;
      target.attentionW = cell.attention ? 1 : 0;
      target.alpha = visual.removed ? 0 : 1;
      target.dim = memberDimTarget(this.selection, { kind: "cell", id: visual.id }, scene);
    }
    for (const id of [...this.cellTargets.keys()]) {
      if (!this.cellVisuals.has(id)) this.cellTargets.delete(id);
    }
  }

  /**
   * Advance visual time by one bounded step and ease every visual property
   * toward its target. Returns the new visual time.
   */
  frame(nowMs: number): number {
    let dt = 0;
    if (this.lastFrameAt !== null) {
      dt = Math.min(Math.max((nowMs - this.lastFrameAt) / 1000, 0), MAX_FRAME_DELTA_SECONDS);
    }
    this.lastFrameAt = nowMs;
    this.time += dt;
    if (dt > 0) this.ease(dt);
    return this.time;
  }

  private ease(dt: number): void {
    const scene = this.scene;
    let settled = true;
    for (const visual of this.flowVisuals.values()) {
      const targets = this.flowTargets.get(visual.id);
      if (!targets) continue;
      // Presence is a linear ramp with asymmetric speeds; reappearance during
      // decay reverses from the current value — no reset, no spike.
      if (visual.presence !== targets.presence) {
        const step = dt / (targets.presence > visual.presence ? ONSET_SECONDS : DECAY_SECONDS);
        visual.presence =
          targets.presence > visual.presence
            ? Math.min(targets.presence, visual.presence + step)
            : Math.max(targets.presence, visual.presence - step);
        settled = false;
      }
      visual.liveness = approach(visual.liveness, targets.liveness, dt, TAU.treatment);
      visual.breath = approach(visual.breath, targets.breath, dt, TAU.treatment);
      visual.staleW = approach(visual.staleW, targets.staleW, dt, TAU.treatment);
      visual.zeroW = approach(visual.zeroW, targets.zeroW, dt, TAU.treatment);
      visual.rate = approachRate(visual.rate, targets.rate, dt);
      visual.dim = approach(visual.dim, targets.dim, dt, TAU.dim);
      if (
        visual.liveness !== targets.liveness ||
        visual.breath !== targets.breath ||
        visual.staleW !== targets.staleW ||
        visual.zeroW !== targets.zeroW ||
        visual.rate !== targets.rate ||
        visual.dim !== targets.dim
      ) {
        settled = false;
      }
      visual.channels.forEach((channel, i) => {
        channel.rate = approachRate(channel.rate, targets.channelRates[i] ?? 0, dt);
        if (channel.rate !== (targets.channelRates[i] ?? 0)) settled = false;
        const count = targets.channelCounts[i] ?? 0;
        for (let slot = 0; slot < MAX_PARTICLE_SLOTS; slot++) {
          const target = slot < count ? 1 : 0;
          const alpha = approach(channel.slotAlphas[slot]!, target, dt, TAU.slot);
          channel.slotAlphas[slot] = alpha;
          if (alpha !== target) settled = false;
        }
      });
    }
    // Fully released removed flows leave the stage.
    let pruned = false;
    for (const [id, visual] of this.flowVisuals) {
      if (visual.removed && visual.presence <= 0) {
        this.flowVisuals.delete(id);
        this.flowTargets.delete(id);
        pruned = true;
      }
    }

    for (const visual of this.cellVisuals.values()) {
      const target = this.cellTargets.get(visual.id);
      if (!target) continue;
      visual.weight = approachMemory(visual.weight, target.weight, dt);
      visual.intensity = approach(visual.intensity, target.intensity, dt, TAU.telemetry);
      visual.halo = approach(visual.halo, target.halo, dt, TAU.telemetry);
      visual.unknownW = approach(visual.unknownW, target.unknownW, dt, TAU.treatment);
      visual.attentionW = approach(visual.attentionW, target.attentionW, dt, TAU.treatment);
      visual.alpha = approach(visual.alpha, target.alpha, dt, TAU.treatment);
      visual.dim = approach(visual.dim, target.dim, dt, TAU.dim);
      if (
        visual.weight !== target.weight ||
        visual.intensity !== target.intensity ||
        visual.halo !== target.halo ||
        visual.unknownW !== target.unknownW ||
        visual.attentionW !== target.attentionW ||
        visual.alpha !== target.alpha ||
        visual.dim !== target.dim
      ) {
        settled = false;
      }
    }
    for (const [id, visual] of this.cellVisuals) {
      if (visual.removed && visual.alpha <= 0 && visual.weight <= 0) {
        this.cellVisuals.delete(id);
        this.cellTargets.delete(id);
        pruned = true;
      }
    }

    for (const visual of this.strataVisuals.values()) {
      const pool = visual.pool;
      const fillTarget = Math.min(Math.max(pool.capacityFraction, 0), 1);
      const ioTarget =
        pool.ioFreshness === "live"
          ? Math.max(rateIntensity(pool.readBps ?? 0), rateIntensity(pool.writeBps ?? 0))
          : 0;
      const scrubTarget = pool.scrubbing ? 1 : 0;
      const emberTarget = pool.healthy ? 0 : 1;
      const dimTarget = scene
        ? memberDimTarget(this.selection, { kind: "pool", id: visual.name }, scene)
        : 1;
      visual.fill = approach(visual.fill, fillTarget, dt, TAU.fill);
      visual.io = approach(visual.io, ioTarget, dt, TAU.telemetry);
      visual.scrubW = approach(visual.scrubW, scrubTarget, dt, TAU.telemetry);
      visual.emberW = approach(visual.emberW, emberTarget, dt, TAU.treatment);
      visual.dim = approach(visual.dim, dimTarget, dt, TAU.dim);
      if (
        visual.fill !== fillTarget ||
        visual.io !== ioTarget ||
        visual.scrubW !== scrubTarget ||
        visual.emberW !== emberTarget ||
        visual.dim !== dimTarget
      ) {
        settled = false;
      }
    }

    for (const visual of this.anchorVisuals.values()) {
      const model = visual.model;
      const glowTarget = model.active ? 0.35 + model.glow * 0.65 : 0.16;
      const dimTarget = scene
        ? memberDimTarget(this.selection, { kind: "anchor", id: visual.id }, scene)
        : 1;
      visual.glow = approach(visual.glow, glowTarget, dt, TAU.telemetry);
      visual.dim = approach(visual.dim, dimTarget, dt, TAU.dim);
      if (visual.glow !== glowTarget || visual.dim !== dimTarget) settled = false;
    }

    this.settledFlag = settled;
    if (pruned) this.rebuildStateArrays();
  }

  /** Jump every visual property to its target (frozen/reduced-motion frames). */
  snap(): void {
    for (const visual of this.flowVisuals.values()) {
      const targets = this.flowTargets.get(visual.id);
      if (!targets) continue;
      visual.presence = targets.presence;
      visual.liveness = targets.liveness;
      visual.breath = targets.breath;
      visual.staleW = targets.staleW;
      visual.zeroW = targets.zeroW;
      visual.rate = targets.rate;
      visual.dim = targets.dim;
      visual.channels.forEach((channel, i) => {
        channel.rate = targets.channelRates[i] ?? 0;
        const count = targets.channelCounts[i] ?? 0;
        for (let slot = 0; slot < MAX_PARTICLE_SLOTS; slot++) {
          channel.slotAlphas[slot] = slot < count ? 1 : 0;
        }
      });
    }
    for (const [id, visual] of this.flowVisuals) {
      if (visual.removed) {
        this.flowVisuals.delete(id);
        this.flowTargets.delete(id);
      }
    }
    for (const visual of this.cellVisuals.values()) {
      const target = this.cellTargets.get(visual.id);
      if (!target) continue;
      visual.weight = target.weight;
      visual.intensity = target.intensity;
      visual.halo = target.halo;
      visual.unknownW = target.unknownW;
      visual.attentionW = target.attentionW;
      visual.alpha = target.alpha;
      visual.dim = target.dim;
    }
    for (const [id, visual] of this.cellVisuals) {
      if (visual.removed) {
        this.cellVisuals.delete(id);
        this.cellTargets.delete(id);
      }
    }
    for (const visual of this.strataVisuals.values()) {
      const pool = visual.pool;
      visual.fill = Math.min(Math.max(pool.capacityFraction, 0), 1);
      visual.io =
        pool.ioFreshness === "live"
          ? Math.max(rateIntensity(pool.readBps ?? 0), rateIntensity(pool.writeBps ?? 0))
          : 0;
      visual.scrubW = pool.scrubbing ? 1 : 0;
      visual.emberW = pool.healthy ? 0 : 1;
      visual.dim = this.scene
        ? memberDimTarget(this.selection, { kind: "pool", id: visual.name }, this.scene)
        : 1;
    }
    for (const visual of this.anchorVisuals.values()) {
      visual.glow = visual.model.active ? 0.35 + visual.model.glow * 0.65 : 0.16;
      visual.dim = this.scene
        ? memberDimTarget(this.selection, { kind: "anchor", id: visual.id }, this.scene)
        : 1;
    }
    this.settledFlag = true;
    this.rebuildStateArrays();
  }

  private rebuildStateArrays(): void {
    this.state = {
      flows: [...this.flowVisuals.values()],
      cells: [...this.cellVisuals.values()],
      strata: [...this.strataVisuals.values()],
      anchors: [...this.anchorVisuals.values()],
    };
  }

  /** Every ease has reached its target and nothing is decaying. */
  settled(): boolean {
    return this.settledFlag;
  }

  /**
   * True while the stage needs a continuous rAF loop: any transitional ease
   * still moving, or any continuously-animating truth (travelling particles,
   * breathing state-only ribbon, scrub sweep, attention pulse).
   */
  animating(): boolean {
    if (!this.settledFlag) return true;
    for (const visual of this.flowVisuals.values()) {
      if (visual.presence <= 0) continue;
      if (visual.liveness > 0.02 && visual.rate >= FLOW_DEADBAND_BPS) return true;
      if (visual.breath > 0.02) return true;
    }
    for (const visual of this.strataVisuals.values()) {
      if (visual.scrubW > 0.02) return true;
    }
    for (const visual of this.cellVisuals.values()) {
      if (visual.attentionW > 0.02 && visual.alpha > 0.02) return true;
    }
    return false;
  }

  /** Diagnostic counters for the soak harness — bounded by construction. */
  debugCounts(): {
    flows: number;
    decaying: number;
    cells: number;
    visibleParticles: number;
  } {
    let visibleParticles = 0;
    let decaying = 0;
    for (const visual of this.flowVisuals.values()) {
      if (visual.removed) decaying += 1;
      for (const channel of visual.channels) {
        for (const alpha of channel.slotAlphas) {
          if (alpha > 0.02) visibleParticles += 1;
        }
      }
    }
    return {
      flows: this.flowVisuals.size,
      decaying,
      cells: this.cellVisuals.size,
      visibleParticles,
    };
  }
}
