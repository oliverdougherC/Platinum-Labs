/**
 * V4 Kinetic Flow Canvas — Canvas 2D painter.
 *
 * Stateless: every frame is a pure function of (scene, layout, t, envelopes,
 * selection), which is what makes frozen screenshots deterministic and lets
 * the caller park the rAF loop whenever nothing on screen is moving. All text
 * lives in the DOM overlay; the canvas draws only light: glow pools, flow
 * ribbons, particles, the workload field, and the storage strata.
 */

import type { KineticFlow, KineticScene, FieldCellModel } from "./model";
import { rateIntensity } from "./model";
import type { KineticLayout, SampledPath } from "./layout";
import { pointAt } from "./layout";
import { particlePeriodSeconds, widthFromRate } from "@/lib/topology/smoothing";

// --- palette --------------------------------------------------------------------
// Restrained cool luminous tones on near-black; ember amber is reserved for
// attention and never used decoratively.

type Rgb = readonly [number, number, number];

export const KINETIC_TONES: Record<string, Rgb> = {
  neutral: [214, 222, 232],
  in: [138, 180, 216], // glacial blue — ingress / writes
  out: [150, 206, 188], // sea glass — playback / egress
  import: [178, 168, 212], // dry lavender — pool → pool copy
  control: [148, 156, 172], // whisper gray — orchestration signals
  attention: [226, 168, 108], // ember — attention only
  ok: [124, 200, 152],
  stale: [128, 136, 150],
};

function rgba(c: Rgb, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

export interface KineticSelection {
  kind: "anchor" | "pool" | "cell" | "orchestrator" | "edge";
  id: string;
}

export interface FlowEnvelope {
  /** 0..1 onset/decay multiplier. */
  alpha: number;
}

export interface KineticFrameOptions {
  t: number;
  selection: KineticSelection | null;
  /** Per-flow onset/decay envelopes; missing id = fully present. */
  envelopes?: ReadonlyMap<string, FlowEnvelope>;
  /**
   * No phase motion: breathing and sweeps hold a fixed pose. Frozen
   * screenshots still show the particle field, placed at the given `t`.
   */
  still?: boolean;
  /** Replace particles with static direction chevrons (reduced motion). */
  marks?: boolean;
}

// --- relatedness (selection dimming) ----------------------------------------------

function flowTouches(flow: KineticFlow, selection: KineticSelection): boolean {
  const refs = [flow.from, flow.to];
  return refs.some((ref) => {
    if (selection.kind === "anchor") return ref.kind === "anchor" && ref.id === selection.id;
    if (selection.kind === "pool") return ref.kind === "pool" && ref.name === selection.id;
    if (selection.kind === "orchestrator")
      return ref.kind === "orchestrator" && ref.id === selection.id;
    if (selection.kind === "edge") return ref.kind === "edge" && ref.id === selection.id;
    return false;
  });
}

export function selectionDim(
  selection: KineticSelection | null,
  member: KineticSelection,
  scene: KineticScene,
): number {
  if (!selection) return 1;
  if (selection.kind === member.kind && selection.id === member.id) return 1;
  // Pools stay lit when a selected flow endpoint references them and vice
  // versa: anything reachable through a flow shared with the selection.
  const related = scene.flows.some(
    (flow) => flowTouches(flow, selection) && flowTouches(flow, member),
  );
  return related ? 1 : 0.22;
}

// --- primitives --------------------------------------------------------------------

function glowPool(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  tone: Rgb,
  energy: number,
): void {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, rgba(tone, 0.16 * energy + 0.03));
  grad.addColorStop(0.55, rgba(tone, 0.07 * energy + 0.012));
  grad.addColorStop(1, rgba(tone, 0));
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.52);
  ctx.translate(-x, -y);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  path: SampledPath,
  width: number,
  style: string,
  dash?: number[],
): void {
  ctx.beginPath();
  ctx.moveTo(path.points[0]!.x, path.points[0]!.y);
  for (let i = 1; i < path.points.length; i++) {
    ctx.lineTo(path.points[i]!.x, path.points[i]!.y);
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.lineCap = "round";
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

const PARTICLE_SPEED = 86; // px/s — fixed, so velocity never encodes rate
const MAX_PARTICLES_PER_CHANNEL = 42;

function drawParticles(
  ctx: CanvasRenderingContext2D,
  path: SampledPath,
  bps: number,
  direction: "forward" | "reverse",
  tone: Rgb,
  t: number,
  phaseSeed: number,
  lateral: number,
  alpha: number,
): void {
  const period = particlePeriodSeconds(bps);
  if (!Number.isFinite(period)) return;
  const spacing = Math.min(Math.max(PARTICLE_SPEED * period, 30), 460);
  const count = Math.min(Math.ceil(path.total / spacing) + 1, MAX_PARTICLES_PER_CHANNEL);
  const travel = (t * PARTICLE_SPEED + phaseSeed * spacing) % spacing;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const r = Math.min(1.5 + widthFromRate(bps) * 0.16, 3.1);
  for (let i = 0; i < count; i++) {
    const d = i * spacing + travel;
    if (d > path.total) continue;
    const dist = direction === "forward" ? d : path.total - d;
    // Short comet tail: three ghosts trailing the head along the path.
    for (let k = 3; k >= 0; k--) {
      const back = k * (5.5 + r);
      const p = pointAt(path, direction === "forward" ? dist - back : dist + back);
      const px = p.x + -p.ty * lateral;
      const py = p.y + p.tx * lateral;
      const fade = k === 0 ? 1 : 0.34 / k;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r * 3.4);
      grad.addColorStop(0, rgba(tone, 0.5 * fade * alpha));
      grad.addColorStop(0.4, rgba(tone, 0.18 * fade * alpha));
      grad.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawStillMarks(
  ctx: CanvasRenderingContext2D,
  path: SampledPath,
  direction: "forward" | "reverse",
  tone: Rgb,
  alpha: number,
): void {
  // Reduced-motion / stale replacement: direction chevrons at fixed stations.
  ctx.save();
  for (const f of [0.3, 0.55, 0.8]) {
    const p = pointAt(path, path.total * f);
    const sign = direction === "forward" ? 1 : -1;
    const tx = p.tx * sign;
    const ty = p.ty * sign;
    const s = 4.2;
    ctx.beginPath();
    ctx.moveTo(p.x - tx * s - -ty * s * 0.8, p.y - ty * s - tx * s * 0.8);
    ctx.lineTo(p.x + tx * s, p.y + ty * s);
    ctx.lineTo(p.x - tx * s + -ty * s * 0.8, p.y - ty * s + tx * s * 0.8);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(tone, 0.5 * alpha);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.restore();
}

function endpointWake(
  ctx: CanvasRenderingContext2D,
  path: SampledPath,
  at: "start" | "end",
  tone: Rgb,
  energy: number,
): void {
  const p = pointAt(path, at === "start" ? 0 : path.total);
  const r = 7 + energy * 9;
  const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
  grad.addColorStop(0, rgba(tone, 0.4 * energy + 0.06));
  grad.addColorStop(1, rgba(tone, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

// --- flows -----------------------------------------------------------------------------

function toneOf(flow: KineticFlow): Rgb {
  return KINETIC_TONES[flow.tone] ?? KINETIC_TONES.neutral!;
}

function drawFlow(
  ctx: CanvasRenderingContext2D,
  flow: KineticFlow,
  path: SampledPath,
  t: number,
  envelope: number,
  dim: number,
  still: boolean,
  marks: boolean,
): void {
  const alpha = envelope * dim;
  if (alpha <= 0.01) return;
  const tone = toneOf(flow);

  if (flow.treatment === "confirmed-zero") {
    strokePath(ctx, path, 1, rgba(tone, 0.1 * alpha));
    return;
  }
  if (flow.treatment === "stale") {
    strokePath(ctx, path, 1.6, rgba(KINETIC_TONES.stale!, 0.16 * alpha));
    drawStillMarks(ctx, path, "forward", KINETIC_TONES.stale!, alpha * 0.7);
    return;
  }
  if (flow.treatment === "state-only") {
    // Active-but-unknown rate: a breathing whisper, never particles. The
    // control-plane organize signal additionally reads as a dashed thread.
    const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.15 + path.total * 0.01);
    const a = (0.07 + 0.08 * breath) * alpha;
    const dash = flow.tone === "control" ? [2, 11] : undefined;
    strokePath(ctx, path, 1.3, rgba(tone, a), dash);
    endpointWake(ctx, path, "end", tone, 0.24 * alpha * (0.6 + 0.4 * breath));
    return;
  }

  // Live measured/derived transfer.
  const channels = flow.channels.filter(
    (c) => c.bytesPerSecond !== null && c.bytesPerSecond > 0,
  );
  const headline = flow.rateBps ?? 0;
  const w = Math.max(widthFromRate(headline), 1.6);
  const energy = rateIntensity(headline);

  // Ribbon: wide soft halo, translucent body, brighter core.
  strokePath(ctx, path, w * 3.2, rgba(tone, 0.045 * alpha));
  strokePath(ctx, path, w * 1.35, rgba(tone, 0.1 * alpha));
  strokePath(ctx, path, Math.max(w * 0.42, 1), rgba(tone, 0.2 * alpha));

  const twoWay = channels.length > 1;
  channels.forEach((channel, i) => {
    const lateral = twoWay ? (channel.direction === "forward" ? -3.4 : 3.4) : 0;
    if (marks) {
      drawStillMarks(ctx, path, channel.direction, tone, alpha);
      return;
    }
    drawParticles(
      ctx,
      path,
      channel.bytesPerSecond!,
      channel.direction,
      tone,
      t,
      ((path.total * 0.37 + i * 61) % 97) / 97,
      lateral,
      alpha,
    );
  });

  endpointWake(ctx, path, "end", tone, energy * alpha);
  endpointWake(ctx, path, "start", tone, energy * 0.55 * alpha);
}

// --- workload field -----------------------------------------------------------------------

function drawCell(
  ctx: CanvasRenderingContext2D,
  cell: FieldCellModel,
  x: number,
  y: number,
  r: number,
  t: number,
  dim: number,
  still: boolean,
): void {
  const neutral = KINETIC_TONES.neutral!;
  if (cell.attention) {
    const amber = KINETIC_TONES.attention!;
    const pulse = still ? 0.75 : 0.65 + 0.35 * Math.sin(t * 2.1 + x * 0.05);
    ctx.beginPath();
    ctx.arc(x, y, r + 3.4, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(amber, 0.55 * pulse * dim);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(amber, 0.5 * dim);
    ctx.fill();
    return;
  }
  if (cell.unverified || cell.intensity === null) {
    // Unknown ≠ proven quiet: hollow ring, never a dim confirmed dot.
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r - 0.5, 1.6), 0, Math.PI * 2);
    ctx.strokeStyle = rgba(neutral, 0.22 * dim);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const glow = 0.16 + cell.intensity * 0.72;
  if (cell.ioHalo > 0.04) {
    const halo = ctx.createRadialGradient(x, y, r * 0.4, x, y, r + 3 + cell.ioHalo * 7);
    halo.addColorStop(0, rgba(KINETIC_TONES.in!, 0));
    halo.addColorStop(0.7, rgba(KINETIC_TONES.in!, 0.1 * cell.ioHalo * dim));
    halo.addColorStop(1, rgba(KINETIC_TONES.in!, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r + 3 + cell.ioHalo * 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(neutral, glow * dim);
  ctx.fill();
}

// --- storage --------------------------------------------------------------------------------

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStratum(
  ctx: CanvasRenderingContext2D,
  scene: KineticScene,
  index: number,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  dim: number,
  still: boolean,
): void {
  const pool = scene.storage[index]!;
  const tone: Rgb =
    pool.capacityTone === "critical"
      ? [222, 130, 130]
      : pool.capacityTone === "warn"
        ? KINETIC_TONES.attention!
        : KINETIC_TONES.in!;
  const neutral = KINETIC_TONES.neutral!;

  // No bed fill: the stratum is a vessel of liquid light, not a panel. The
  // vessel itself is only implied — a whisper of a floor line and the fill.
  // Horizontal end-fades keep every line from reading as a box edge.
  const fadeLine = (lineY: number, tone2: Rgb, a: number) => {
    const fade = Math.min(26, w * 0.12);
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, rgba(tone2, 0));
    grad.addColorStop(fade / w, rgba(tone2, a));
    grad.addColorStop(1 - fade / w, rgba(tone2, a));
    grad.addColorStop(1, rgba(tone2, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x, lineY, w, 1);
  };
  fadeLine(y + h, neutral, 0.055 * dim);

  // Capacity is a liquid level: a luminous meniscus line whose height within
  // the vessel is the fill fraction, with light pooling just beneath it. The
  // body below stays almost black — never a slab.
  const fillH = h * Math.min(Math.max(pool.capacityFraction, 0), 1);
  if (fillH > 0.5) {
    ctx.save();
    roundedRectPath(ctx, x, y, w, h, 7);
    ctx.clip();
    const meniscusY = y + h - fillH;
    const glowDepth = Math.min(fillH, 22);
    const grad = ctx.createLinearGradient(0, meniscusY, 0, meniscusY + glowDepth);
    grad.addColorStop(0, rgba(tone, 0.12 * dim));
    grad.addColorStop(1, rgba(tone, 0.012 * dim));
    ctx.fillStyle = grad;
    ctx.fillRect(x, meniscusY, w, glowDepth);
    if (fillH > glowDepth) {
      ctx.fillStyle = rgba(tone, 0.012 * dim);
      ctx.fillRect(x, meniscusY + glowDepth, w, fillH - glowDepth);
    }
    // Meniscus.
    fadeLine(meniscusY, tone, 0.4 * dim);
    // Scrub: a slow luminous sweep through the body of the pool.
    if (pool.scrubbing) {
      const phase = still ? 0.35 : (t * 0.06) % 1;
      const sx = x + w * phase;
      const sweep = ctx.createLinearGradient(sx - w * 0.18, 0, sx + w * 0.18, 0);
      sweep.addColorStop(0, rgba(neutral, 0));
      sweep.addColorStop(0.5, rgba(neutral, 0.07 * dim));
      sweep.addColorStop(1, rgba(neutral, 0));
      ctx.fillStyle = sweep;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  // Healthy is silent: no vessel outline at all. An unhealthy pool gets an
  // ember rim across its top.
  if (!pool.healthy) {
    fadeLine(y, KINETIC_TONES.attention!, 0.55 * dim);
  }

  // Live I/O wakes the surface: soft light bleeding from the top edge.
  const io =
    pool.ioFreshness === "live"
      ? Math.max(rateIntensity(pool.readBps ?? 0), rateIntensity(pool.writeBps ?? 0))
      : 0;
  if (io > 0) {
    const grad = ctx.createLinearGradient(0, y, 0, y + Math.min(h, 14));
    grad.addColorStop(0, rgba(neutral, 0.09 * io * dim));
    grad.addColorStop(1, rgba(neutral, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, Math.min(h, 14));
  }
}

// --- frame ------------------------------------------------------------------------------------

export function drawKineticFrame(
  ctx: CanvasRenderingContext2D,
  scene: KineticScene,
  layout: KineticLayout,
  options: KineticFrameOptions,
): void {
  const { t, selection } = options;
  const still = options.still ?? false;
  ctx.clearRect(0, 0, layout.w, layout.h);

  // Anchor glow pools (always present as a soft ground; energy from truth).
  for (const anchor of layout.anchors) {
    const model = scene.anchors.find((a) => a.id === anchor.id);
    if (!model) continue;
    const dim = selectionDim(selection, { kind: "anchor", id: anchor.id }, scene);
    glowPool(
      ctx,
      anchor.x,
      anchor.y + anchor.r * 0.34,
      anchor.r,
      model.active ? toneForAnchor(model.id) : KINETIC_TONES.neutral!,
      (model.active ? 0.35 + model.glow * 0.65 : 0.16) * dim,
    );
  }

  // Storage strata.
  layout.strata.forEach((s, i) => {
    const dim = selectionDim(selection, { kind: "pool", id: s.name }, scene);
    drawStratum(ctx, scene, i, s.x, s.y, s.w, s.h, t, dim, still);
  });

  // Workload field.
  const cellsById = new Map<string, FieldCellModel>();
  for (const group of scene.field) {
    for (const cell of group.cells) cellsById.set(cell.id, cell);
  }
  for (const group of layout.groups) {
    for (const placed of group.cells) {
      const cell = cellsById.get(placed.id);
      if (!cell) continue;
      const dim = selectionDim(selection, { kind: "cell", id: placed.id }, scene);
      drawCell(ctx, cell, placed.x, placed.y, placed.r, t, dim, still);
    }
  }

  // Flows above everything else on the canvas.
  const marks = options.marks ?? false;
  for (const placement of layout.flows) {
    const flow = scene.flows.find((f) => f.id === placement.id);
    if (!flow) continue;
    const envelope = options.envelopes?.get(flow.id)?.alpha ?? 1;
    const dim = flowSelectionDim(selection, flow, scene);
    drawFlow(ctx, flow, placement.path, t, envelope, dim, still, marks);
  }
}

function toneForAnchor(id: "qbittorrent" | "jellyfin"): Rgb {
  return id === "qbittorrent" ? KINETIC_TONES.in! : KINETIC_TONES.out!;
}

function flowSelectionDim(
  selection: KineticSelection | null,
  flow: KineticFlow,
  scene: KineticScene,
): number {
  if (!selection) return 1;
  if (selection.kind === "cell") return 0.22;
  void scene;
  return flowTouches(flow, selection) ? 1 : 0.16;
}

/**
 * True when the scene needs a continuous animation loop: any moving particles,
 * breathing state-only ribbon, attention pulse, or scrub sweep. A quiet scene
 * with none of these parks the rAF loop entirely.
 */
export function sceneAnimates(scene: KineticScene): boolean {
  if (scene.flows.some((f) => f.treatment === "particles" || f.treatment === "state-only")) {
    return true;
  }
  if (scene.storage.some((s) => s.scrubbing)) return true;
  if (scene.field.some((g) => g.cells.some((c) => c.attention))) return true;
  return false;
}
