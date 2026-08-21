/**
 * V4 Kinetic Flow Canvas — Canvas 2D painter.
 *
 * Draws one frame from the engine's VISUAL state (see engine.ts): the painter
 * itself is stateless and boring by design — every treatment is a weighted
 * layer whose weights the engine eases, so state transitions morph instead of
 * snapping and a frozen frame is a pure function of (scene, layout, t).
 *
 * All text lives in the DOM overlay; the canvas draws only light: glow pools,
 * flow ribbons, particles, the workload field, and the storage strata.
 * Per-frame allocation is deliberately minimal: comet heads, halos and
 * endpoint wakes are pre-rendered tone sprites drawn with drawImage, and the
 * frame loop iterates compiled visual arrays — no per-frame Maps, finds, or
 * radial-gradient construction in the hot path.
 */

import type { KineticScene } from "./model";
import { rateIntensity } from "./model";
import type { KineticLayout, SampledPath } from "./layout";
import { pointAt } from "./layout";
import { widthFromRate } from "@/lib/topology/smoothing";
import {
  slotPosition,
  MAX_PARTICLE_SLOTS,
  type CellVisual,
  type FlowVisual,
  type KineticVisualState,
  type StratumVisual,
} from "./engine";

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
  critical: [222, 130, 130],
};

function rgba(c: Rgb, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

export interface KineticSelection {
  kind: "anchor" | "pool" | "cell" | "orchestrator" | "edge";
  id: string;
}

export interface KineticFrameOptions {
  t: number;
  /**
   * No phase motion: breathing and sweeps hold a fixed pose. Frozen
   * screenshots still show the particle field, placed at the given `t`.
   */
  still?: boolean;
  /** Replace particles with static direction chevrons (reduced motion). */
  marks?: boolean;
}

// --- sprite cache -----------------------------------------------------------------
// Radial-gradient light is expensive to construct per particle per frame.
// Each (tone, shape) pair is rendered once to a small offscreen canvas and
// composited with drawImage + globalAlpha. The cache is bounded by the tone
// table (single-digit entries per shape).

type SpriteShape = "comet" | "halo" | "wake";

const SPRITE_SIZE = 64;
const spriteCache = new Map<string, CanvasImageSource>();

function sprite(tone: Rgb, shape: SpriteShape): CanvasImageSource | null {
  const key = `${shape}:${tone[0]},${tone[1]},${tone[2]}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const c = SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  if (shape === "comet") {
    grad.addColorStop(0, rgba(tone, 0.5));
    grad.addColorStop(0.4, rgba(tone, 0.18));
    grad.addColorStop(1, rgba(tone, 0));
  } else if (shape === "halo") {
    grad.addColorStop(0, rgba(tone, 0));
    grad.addColorStop(0.7, rgba(tone, 0.1));
    grad.addColorStop(1, rgba(tone, 0));
  } else {
    grad.addColorStop(0, rgba(tone, 0.46));
    grad.addColorStop(1, rgba(tone, 0));
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  spriteCache.set(key, canvas);
  return canvas;
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  tone: Rgb,
  shape: SpriteShape,
  x: number,
  y: number,
  radius: number,
  alpha: number,
): void {
  if (alpha <= 0.004 || radius <= 0) return;
  const image = sprite(tone, shape);
  if (!image) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = Math.min(alpha, 1);
  ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalAlpha = prev;
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
  // Two anchors per frame: gradient construction here is negligible and the
  // squashed-ellipse transform makes a sprite awkward.
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
  if (energy <= 0.01) return;
  const p = pointAt(path, at === "start" ? 0 : path.total);
  const r = 7 + energy * 9;
  drawSprite(ctx, tone, "wake", p.x, p.y, r, Math.min(0.9 * energy + 0.12, 1));
}

// --- flows -----------------------------------------------------------------------------

function toneOf(flow: FlowVisual["flow"]): Rgb {
  return KINETIC_TONES[flow.tone] ?? KINETIC_TONES.neutral!;
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  visual: FlowVisual,
  channelIndex: number,
  tone: Rgb,
  t: number,
  lateral: number,
  alpha: number,
): void {
  const channel = visual.channels[channelIndex]!;
  const path = visual.path;
  const r = Math.min(1.5 + widthFromRate(channel.rate) * 0.16, 3.1);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let slot = 0; slot < MAX_PARTICLE_SLOTS; slot++) {
    const slotAlpha = channel.slotAlphas[slot]!;
    if (slotAlpha <= 0.02) continue;
    const norm = slotPosition(channel.seed, slot, t, path.total);
    const dist = channel.direction === "forward" ? norm * path.total : (1 - norm) * path.total;
    // Short comet tail: three ghosts trailing the head along the path.
    for (let k = 3; k >= 0; k--) {
      const back = k * (5.5 + r);
      const p = pointAt(
        path,
        channel.direction === "forward" ? dist - back : dist + back,
      );
      const px = p.x + -p.ty * lateral;
      const py = p.y + p.tx * lateral;
      const fade = k === 0 ? 1 : 0.34 / k;
      drawSprite(ctx, tone, "comet", px, py, r * 3.4, fade * alpha * slotAlpha);
    }
  }
  ctx.restore();
}

function drawFlow(
  ctx: CanvasRenderingContext2D,
  visual: FlowVisual,
  t: number,
  still: boolean,
  marks: boolean,
): void {
  const alpha = visual.presence * visual.dim;
  if (alpha <= 0.01) return;
  const flow = visual.flow;
  const path = visual.path;
  const tone = toneOf(flow);

  // Confirmed-zero layer: hairline presence, nothing animates.
  if (visual.zeroW > 0.01) {
    strokePath(ctx, path, 1, rgba(tone, 0.1 * alpha * visual.zeroW));
  }

  // Stale layer: frozen desaturated ribbon with static chevrons.
  if (visual.staleW > 0.01) {
    const a = alpha * visual.staleW;
    strokePath(ctx, path, 1.6, rgba(KINETIC_TONES.stale!, 0.16 * a));
    drawStillMarks(ctx, path, "forward", KINETIC_TONES.stale!, a * 0.7);
  }

  // State-only layer: active-but-unknown rate breathes; never particles. The
  // control-plane organize signal additionally reads as a dashed thread.
  if (visual.breath > 0.01) {
    const a0 = alpha * visual.breath;
    const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.15 + path.total * 0.01);
    const a = (0.07 + 0.08 * breath) * a0;
    const dash = flow.tone === "control" ? [2, 11] : undefined;
    strokePath(ctx, path, 1.3, rgba(tone, a), dash);
    endpointWake(ctx, path, "end", tone, 0.24 * a0 * (0.6 + 0.4 * breath));
  }

  // Live layer: measured/derived transfer — ribbon, particles, wakes. Width
  // and energy come from the EASED rate so magnitude changes glide.
  if (visual.liveness > 0.01) {
    const a = alpha * visual.liveness;
    const w = Math.max(widthFromRate(visual.rate), 1.6);
    const energy = rateIntensity(visual.rate);

    strokePath(ctx, path, w * 3.2, rgba(tone, 0.045 * a));
    strokePath(ctx, path, w * 1.35, rgba(tone, 0.1 * a));
    strokePath(ctx, path, Math.max(w * 0.42, 1), rgba(tone, 0.2 * a));

    const twoWay =
      visual.channels.filter((c) => c.slotAlphas.some((s) => s > 0.02)).length > 1;
    visual.channels.forEach((channel, i) => {
      const lateral = twoWay ? (channel.direction === "forward" ? -3.4 : 3.4) : 0;
      if (marks) {
        if (channel.slotAlphas.some((s) => s > 0.02)) {
          drawStillMarks(ctx, path, channel.direction, tone, a);
        }
        return;
      }
      drawParticles(ctx, visual, i, tone, t, lateral, a);
    });

    endpointWake(ctx, path, "end", tone, energy * a);
    endpointWake(ctx, path, "start", tone, energy * 0.55 * a);
  }
}

// --- workload field -----------------------------------------------------------------------

function drawCell(
  ctx: CanvasRenderingContext2D,
  visual: CellVisual,
  t: number,
  still: boolean,
): void {
  const dim = visual.dim * visual.alpha;
  if (dim <= 0.01) return;
  const { x, y, r } = visual;
  const neutral = KINETIC_TONES.neutral!;

  if (visual.attentionW > 0.01) {
    const amber = KINETIC_TONES.attention!;
    const a = dim * visual.attentionW;
    const pulse = still ? 0.75 : 0.65 + 0.35 * Math.sin(t * 2.1 + x * 0.05);
    roundedRectPath(ctx, x - (r + 3.4), y - (r + 3.4), (r + 3.4) * 2, (r + 3.4) * 2, 6);
    ctx.strokeStyle = rgba(amber, 0.55 * pulse * a);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    roundedRectPath(ctx, x - r, y - r, r * 2, r * 2, 5);
    ctx.fillStyle = rgba(amber, 0.5 * a);
    ctx.fill();
  }

  if (visual.unknownW > 0.01) {
    // Unknown ≠ proven quiet: hollow dashed ring, never a dim confirmed dot.
    const inner = Math.max(r - 0.5, 1.6);
    roundedRectPath(ctx, x - inner, y - inner, inner * 2, inner * 2, 4);
    ctx.strokeStyle = rgba(neutral, 0.22 * dim * visual.unknownW);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const knownW = Math.max(0, 1 - visual.unknownW - visual.attentionW);
  if (knownW > 0.01) {
    if (visual.halo > 0.04) {
      drawSprite(
        ctx,
        KINETIC_TONES.in!,
        "halo",
        x,
        y,
        r + 3 + visual.halo * 7,
        visual.halo * dim * knownW,
      );
    }
    const glow = 0.16 + visual.intensity * 0.72;
    roundedRectPath(ctx, x - r, y - r, r * 2, r * 2, 5);
    ctx.fillStyle = rgba(neutral, glow * dim * knownW);
    ctx.fill();
  }
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
  visual: StratumVisual,
  t: number,
  still: boolean,
): void {
  const pool = visual.pool;
  const { x, y, w, h } = visual;
  const dim = visual.dim;
  const tone: Rgb =
    pool.capacityTone === "critical"
      ? KINETIC_TONES.critical!
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
  const fillH = h * visual.fill;
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
    if (visual.scrubW > 0.01) {
      const phase = still ? 0.35 : (t * 0.06) % 1;
      const sx = x + w * phase;
      const sweep = ctx.createLinearGradient(sx - w * 0.18, 0, sx + w * 0.18, 0);
      sweep.addColorStop(0, rgba(neutral, 0));
      sweep.addColorStop(0.5, rgba(neutral, 0.07 * dim * visual.scrubW));
      sweep.addColorStop(1, rgba(neutral, 0));
      ctx.fillStyle = sweep;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  // Healthy is silent: no vessel outline at all. An unhealthy pool gets an
  // ember rim across its top.
  if (visual.emberW > 0.01) {
    fadeLine(y, KINETIC_TONES.attention!, 0.55 * dim * visual.emberW);
  }

  // Live I/O wakes the surface: soft light bleeding from the top edge.
  if (visual.io > 0.01) {
    const grad = ctx.createLinearGradient(0, y, 0, y + Math.min(h, 14));
    grad.addColorStop(0, rgba(neutral, 0.09 * visual.io * dim));
    grad.addColorStop(1, rgba(neutral, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, Math.min(h, 14));
  }
}

// --- frame ------------------------------------------------------------------------------------

function toneForAnchor(id: "qbittorrent" | "jellyfin"): Rgb {
  return id === "qbittorrent" ? KINETIC_TONES.in! : KINETIC_TONES.out!;
}

export function drawKineticFrame(
  ctx: CanvasRenderingContext2D,
  state: KineticVisualState,
  layout: KineticLayout,
  options: KineticFrameOptions,
): void {
  const { t } = options;
  const still = options.still ?? false;
  const marks = options.marks ?? false;
  ctx.clearRect(0, 0, layout.w, layout.h);

  // Anchor glow pools (always present as a soft ground; energy from truth).
  for (const anchor of state.anchors) {
    glowPool(
      ctx,
      anchor.x,
      anchor.y + anchor.r * 0.34,
      anchor.r,
      anchor.active ? toneForAnchor(anchor.id) : KINETIC_TONES.neutral!,
      anchor.glow * anchor.dim,
    );
  }

  // Storage strata.
  for (const stratum of state.strata) {
    drawStratum(ctx, stratum, t, still);
  }

  // Workload field.
  for (const cell of state.cells) {
    drawCell(ctx, cell, t, still);
  }

  // Flows above everything else on the canvas.
  for (const flow of state.flows) {
    drawFlow(ctx, flow, t, still, marks);
  }
}

/**
 * True when the TRUTH scene needs a continuous animation loop: any moving
 * particles, breathing state-only ribbon, attention pulse, or scrub sweep.
 * The engine additionally animates while transitional eases settle; the
 * component consults both.
 */
export function sceneAnimates(scene: KineticScene): boolean {
  if (
    scene.flows.some(
      (f) =>
        f.treatment === "particles" ||
        (f.treatment === "state-only" && f.tone !== "control"),
    )
  ) {
    return true;
  }
  if (scene.storage.some((s) => s.scrubbing)) return true;
  if (scene.field.some((g) => g.cells.some((c) => c.attention))) return true;
  return false;
}
