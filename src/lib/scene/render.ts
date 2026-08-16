/**
 * Scene renderer (PLA-266 rebuild) — Canvas 2D draw pass.
 *
 * Pure drawing: no React, no timers, no allocation-heavy per-frame work. The
 * host component owns the rAF loop, the camera, and the DOM overlay; this
 * module turns (model, layout, motion, t) into pixels, in world units under a
 * single transform.
 *
 * Layer order (spec §29 — composition first, polish last):
 *   1 background field        4 flows           7 compute star
 *   2 orbit guides            5 docker belt
 *   3 network boundary        6 bodies (storage, services)
 *
 * Ambient motion uses long incommensurate periods (41 s, 73 s, 127 s) so idle
 * never reads as a loop; everything is a pure function of `t`.
 */

import { colorTokens, type ColorTokenName } from "@/lib/design/tokens";
import { pointAtLength, pointOnCircle, tangentAtLength, TAU } from "@/lib/scene/geom";
import { makeRng } from "@/lib/scene/rng";
import type { BackgroundField } from "@/lib/scene/background";
import type { BodyGeom, SceneLayout } from "@/lib/scene/layout";
import type { SceneModel, ServiceBodyModel, StorageBodyModel } from "@/lib/scene/model";
import type { SceneMotion } from "@/lib/scene/motion";
import type { FlowGeom } from "@/lib/scene/routing";

export interface Camera {
  /** Canvas size in CSS pixels. */
  w: number;
  h: number;
  /** World → screen scale and offset (world fills the canvas, contain-fit). */
  scale: number;
  ox: number;
  oy: number;
}

export interface LiveFlowGeom {
  geom: FlowGeom;
  intensity: number;
}

export interface RenderState {
  model: SceneModel;
  layout: SceneLayout;
  flows: LiveFlowGeom[];
  motion: SceneMotion;
  background: BackgroundField;
  hovered: string | null;
  /** Seconds since mount (frozen renders pass a fixed value). */
  t: number;
  /** False = reduced motion / frozen: static composition, no drift/packets. */
  motionEnabled: boolean;
}

function rgba(token: ColorTokenName, alpha: number): string {
  const [r, g, b] = colorTokens[token];
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Slow ambient phase in [0,1) with a long, non-looping feel. */
function drift(t: number, periodS: number, phase = 0): number {
  return ((t / periodS + phase) % 1 + 1) % 1;
}

function breathe(t: number, periodS: number, phase = 0): number {
  return 0.5 + 0.5 * Math.sin(TAU * drift(t, periodS, phase));
}

// --- background ---------------------------------------------------------------

function drawBackground(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
): void {
  const { w, h } = s.layout.world;
  // Deep ground with the faintest center lift so black never reads as void.
  ctx.fillStyle = rgba("bg", 1);
  ctx.fillRect(0, 0, w, h);
  const core = s.layout.core.center;
  const lift = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, h * 0.9);
  lift.addColorStop(0, "rgba(30,36,52,0.32)");
  lift.addColorStop(0.55, "rgba(18,22,33,0.12)");
  lift.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = lift;
  ctx.fillRect(0, 0, w, h);

  // Dust band.
  for (const d of s.background.dust) {
    const g = ctx.createRadialGradient(d.x * w, d.y * h, 0, d.x * w, d.y * h, d.r * w);
    g.addColorStop(0, rgba("accent", d.alpha));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(d.x * w - d.r * w, d.y * h - d.r * w, d.r * w * 2, d.r * w * 2);
  }

  // Star layers with near-imperceptible parallax drift.
  for (const layer of s.background.layers) {
    const ox = s.motionEnabled
      ? Math.sin(TAU * drift(s.t, 127)) * 4 * layer.drift
      : 0;
    const oy = s.motionEnabled
      ? Math.cos(TAU * drift(s.t, 173)) * 2.6 * layer.drift
      : 0;
    ctx.fillStyle = rgba("fg", 1);
    for (const star of layer.stars) {
      ctx.globalAlpha = star.alpha;
      ctx.beginPath();
      ctx.arc(
        ((star.x * w + ox) % w + w) % w,
        ((star.y * h + oy) % h + h) % h,
        star.r,
        0,
        TAU,
      );
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Vignette.
  const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, h * 0.95);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
}

// --- guides -------------------------------------------------------------------

function drawGuides(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { core, serviceOrbitR } = s.layout;
  // Service orbit: a faint guide arc spanning just beyond the service group.
  ctx.strokeStyle = rgba("hairline", 0.34);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(core.center.x, core.center.y, serviceOrbitR, (86 * Math.PI) / 180, (280 * Math.PI) / 180);
  ctx.stroke();
}

function drawNetworkArc(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const arc = s.layout.networkArc;
  const activity = Math.max(s.motion.rxNorm, s.motion.txNorm);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = rgba("border", 0.8);
  ctx.beginPath();
  ctx.arc(arc.center.x, arc.center.y, arc.r, arc.a0, arc.a1);
  ctx.stroke();
  // Activity: a soft luminous stretch breathing along the rim; unknown network
  // (null rates) never lights up.
  if (s.model.network.rxBps !== null && activity > 0.004) {
    const mid = Math.PI + (s.motionEnabled ? (breathe(s.t, 73) - 0.5) * 0.35 : 0);
    const halfSpan = 0.28 + activity * 0.5;
    const glow = 0.1 + activity * 0.5;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = rgba("accent", glow);
    ctx.beginPath();
    ctx.arc(arc.center.x, arc.center.y, arc.r, mid - halfSpan, mid + halfSpan);
    ctx.stroke();
  }
  // Boundary ticks: quiet punctuation marking the rim as an instrument.
  ctx.strokeStyle = rgba("hairline", 0.6);
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const a = arc.a0 + ((arc.a1 - arc.a0) * i) / 8;
    const p0 = pointOnCircle(arc.center, arc.r - 4, a);
    const p1 = pointOnCircle(arc.center, arc.r + (i % 4 === 0 ? 9 : 5), a);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
}

// --- flows --------------------------------------------------------------------

function strokePath(ctx: CanvasRenderingContext2D, geom: FlowGeom): void {
  const pts = geom.path.points;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.stroke();
}

function drawFlows(ctx: CanvasRenderingContext2D, s: RenderState): void {
  for (const { geom, intensity } of s.flows) {
    if (intensity <= 0.008) continue;
    // The static line must be beautiful on its own (spec §9): a quiet base
    // stroke plus a slightly brighter inner pass, alpha driven by intensity.
    ctx.lineWidth = 1.9;
    ctx.strokeStyle = rgba("accent", 0.05 + 0.1 * intensity);
    strokePath(ctx, geom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba("accent", 0.13 + 0.3 * intensity);
    strokePath(ctx, geom);

    // Terminal glints: the ports softly mark where energy enters/leaves.
    for (const port of [geom.ports.from, geom.ports.to]) {
      const g = ctx.createRadialGradient(port.x, port.y, 0, port.x, port.y, 6);
      g.addColorStop(0, rgba("accent", 0.24 * intensity + 0.06));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(port.x - 6, port.y - 6, 12, 12);
    }

    if (!s.motionEnabled) continue;
    // Moving packets: a few short luminous streaks; count/speed from
    // intensity, positions a pure function of time (no per-frame state).
    const L = geom.path.totalLength;
    const count = 1 + Math.round(intensity * 3);
    const speed = 24 + 62 * intensity; // world units / s — deliberately calm
    const spacing = L / count;
    const streak = Math.min(30, 12 + 20 * intensity);
    for (let i = 0; i < count; i++) {
      const head = ((s.t * speed + i * spacing) % L + L) % L;
      const p = pointAtLength(geom.path, head);
      const tail = pointAtLength(geom.path, Math.max(0, head - streak));
      const tan = tangentAtLength(geom.path, head);
      const grad = ctx.createLinearGradient(tail.x, tail.y, p.x, p.y);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, rgba("accent", 0.34 + 0.42 * intensity));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      // A tiny bright head, slightly ahead along the tangent.
      ctx.fillStyle = rgba("fg", 0.3 + 0.34 * intensity);
      ctx.beginPath();
      ctx.arc(p.x + tan.x * 0.5, p.y + tan.y * 0.5, 1.15, 0, TAU);
      ctx.fill();
    }
  }
}

// --- docker belt --------------------------------------------------------------

function drawDockerBelt(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const docker = s.model.docker;
  if (docker.status === "not-configured") return;
  const belt = s.layout.dockerBelt;
  const rng = makeRng(0xbe17);
  if (docker.status === "unavailable" || docker.dots.length === 0) {
    // Honest absence: a whisper of the belt path, no fabricated asteroids.
    ctx.strokeStyle = rgba("hairline", 0.3);
    ctx.setLineDash([2, 7]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(belt.center.x, belt.center.y, belt.r, belt.a0, belt.a1);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const span = belt.a1 - belt.a0;
  const stale = docker.status === "stale";
  for (let i = 0; i < docker.dots.length; i++) {
    const dot = docker.dots[i]!;
    const fi = docker.dots.length === 1 ? 0.5 : i / (docker.dots.length - 1);
    const a = belt.a0 + span * fi + (rng() - 0.5) * (span / docker.dots.length) * 0.5;
    const rr = belt.r + (rng() - 0.5) * 18;
    const size = 1.1 + rng() * 1.1;
    const p = pointOnCircle(belt.center, rr, a);
    if (dot.bad) {
      ctx.fillStyle = rgba("danger", stale ? 0.4 : 0.85);
      ctx.beginPath();
      ctx.arc(p.x, p.y, size + 0.7, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = rgba("fg", stale ? 0.14 : 0.26 + rng() * 0.14);
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, TAU);
      ctx.fill();
    }
  }
}

// --- storage bodies -----------------------------------------------------------

function drawStorageBody(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  pool: StorageBodyModel,
  g: BodyGeom,
): void {
  const { center, r } = g;
  const fill = s.motion.storageFillOf(pool.name) ?? pool.capacityFraction;
  const io = s.motion.storageIoOf(pool.name);
  const hovered = s.hovered === g.id;
  const toneToken: ColorTokenName =
    pool.capacityTone === "critical" ? "danger" : pool.capacityTone === "warn" ? "warn" : "fg";

  // Atmosphere: a soft halo giving the body mass. Live I/O breathes THROUGH
  // the atmosphere (blue-lit while serving reads, green-lit while absorbing
  // writes) instead of adding another UI ring; unhealthy pools carry a local
  // red cast — the warning lives on the object (spec §16).
  const writeDominant = pool.writeBps > pool.readBps;
  const haloToken: ColorTokenName = !pool.healthy
    ? "danger"
    : io > 0.02
      ? writeDominant
        ? "ok"
        : "accent"
      : "accent";
  const haloPeak = !pool.healthy ? 0.11 : 0.04 + 0.07 * io;
  const halo = ctx.createRadialGradient(center.x, center.y, r * 0.6, center.x, center.y, g.atmosphereR + 10);
  const limbT = (r - r * 0.6) / (g.atmosphereR + 10 - r * 0.6);
  halo.addColorStop(0, rgba(haloToken, haloPeak * 0.22)); // faint interior cast
  halo.addColorStop(Math.min(0.9, limbT), rgba(haloToken, haloPeak)); // peak at limb
  halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(center.x - g.atmosphereR - 12, center.y - g.atmosphereR - 12, (g.atmosphereR + 12) * 2, (g.atmosphereR + 12) * 2);

  // Interior: deterministic surface speckle whose density follows occupancy,
  // fading toward the limb so the disc reads as a body with a surface rather
  // than a noise-filled circle. Texture as data, not decoration.
  let seed = 0;
  for (let i = 0; i < pool.name.length; i++) seed = (seed * 31 + pool.name.charCodeAt(i)) | 0;
  const rng = makeRng(seed ^ 0x5a17);
  const speckles = Math.round((r * r) / 40);
  const rot = s.motionEnabled ? TAU * drift(s.t, 620, seed % 7) : 0;
  for (let i = 0; i < speckles; i++) {
    const ang = rng() * TAU + rot;
    const rad = Math.sqrt(rng()) * (r - 4);
    const within = rng() < 0.18 + fill * 0.6; // density ∝ occupancy
    if (!within) continue;
    const limbFade = 1 - Math.pow(rad / r, 3); // fade near the edge
    const p = pointOnCircle(center, rad, ang);
    ctx.fillStyle = rgba("fg", (0.022 + rng() * 0.042 + (hovered ? 0.014 : 0)) * (0.35 + 0.65 * limbFade));
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.6 + rng() * 0.8, 0, TAU);
    ctx.fill();
  }

  // Body limb: the defining circle.
  ctx.strokeStyle = pool.healthy ? rgba("border", hovered ? 1 : 0.8) : rgba("danger", 0.95);
  ctx.lineWidth = pool.healthy ? 1.1 : 1.5;
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, TAU);
  ctx.stroke();

  // Capacity: an illuminated circumference — a faint full instrument ring,
  // quarter ticks, and a luminous occupancy arc from 12 o'clock. Reads as a
  // lit planetary limb, never as a dashed outline or a pie chart.
  const capR = r + 6;
  ctx.strokeStyle = rgba("hairline", 0.4);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(center.x, center.y, capR, 0, TAU);
  ctx.stroke();
  for (let q = 0; q < 4; q++) {
    const a = -Math.PI / 2 + (q / 4) * TAU;
    const t0 = pointOnCircle(center, capR - 2.4, a);
    const t1 = pointOnCircle(center, capR + 2.4, a);
    ctx.strokeStyle = rgba("hairline", 0.7);
    ctx.beginPath();
    ctx.moveTo(t0.x, t0.y);
    ctx.lineTo(t1.x, t1.y);
    ctx.stroke();
  }
  if (fill > 0.005) {
    const a0 = -Math.PI / 2;
    const a1 = a0 + fill * TAU;
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(toneToken, 0.12);
    ctx.lineWidth = 4.6;
    ctx.beginPath();
    ctx.arc(center.x, center.y, capR, a0, a1);
    ctx.stroke();
    ctx.strokeStyle = rgba(toneToken, 0.62);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(center.x, center.y, capR, a0, a1);
    ctx.stroke();
  }

  // Live I/O, second channel: a sparse drift of luminous surface motes —
  // matter stirring on the body while it works. Deterministic positions,
  // phase-driven by time; still (but present) in reduced-motion.
  if (io > 0.02) {
    const ioToken: ColorTokenName = writeDominant ? "ok" : "accent";
    const moteRng = makeRng(seed ^ 0x10a7);
    const motes = Math.max(3, Math.round((r / 22) * (1 + 3 * io)));
    const phase = s.motionEnabled ? drift(s.t, 26 - 14 * io) : 0.35;
    for (let i = 0; i < motes; i++) {
      const ang = moteRng() * TAU + phase * TAU * (writeDominant ? 1 : -1);
      const rad = (0.25 + moteRng() * 0.6) * r;
      // Each mote fades in/out on its own offset cycle so the surface shimmers
      // rather than blinks.
      const twinkle = 0.5 + 0.5 * Math.sin(TAU * (phase * 2 + moteRng()));
      const p = pointOnCircle(center, rad, ang);
      ctx.fillStyle = rgba(ioToken, (0.1 + 0.3 * io) * twinkle);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.9 + moteRng() * 0.8, 0, TAU);
      ctx.fill();
    }
  }

  // Scrub/resilver: a patient outer marching ring, local to this body.
  if (pool.scrubbing) {
    const spin = s.motionEnabled ? TAU * drift(s.t, 41) : 0;
    ctx.strokeStyle = rgba("accent", 0.4);
    ctx.lineWidth = 1;
    const dashes = 14;
    for (let i = 0; i < dashes; i++) {
      const a = spin + (i / dashes) * TAU;
      ctx.beginPath();
      ctx.arc(center.x, center.y, g.atmosphereR, a, a + (TAU / dashes) * 0.4);
      ctx.stroke();
    }
  }
}

function drawGenericStorage(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const g = s.layout.genericStorage;
  if (!g) return;
  ctx.strokeStyle = rgba("hairline", 0.9);
  ctx.setLineDash([3, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(g.center.x, g.center.y, g.r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
}

// --- service bodies -----------------------------------------------------------

function serviceStroke(s: ServiceBodyModel, glow: number, hovered: boolean): { token: ColorTokenName; alpha: number; width: number } {
  if (s.status === "down") return { token: "danger", alpha: 0.95, width: 1.5 };
  if (s.status === "degraded") return { token: "warn", alpha: 0.9, width: 1.3 };
  if (s.status === "not-configured") return { token: "hairline", alpha: 0.9, width: 1 };
  if (s.status === "neutral") return { token: "border", alpha: 0.75, width: 1 };
  return {
    token: glow > 0.04 ? "accent" : "border",
    alpha: 0.74 + glow * 0.24 + (hovered ? 0.12 : 0),
    width: 1.1 + glow * 0.5,
  };
}

function drawServiceBody(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  svc: ServiceBodyModel,
  g: BodyGeom,
): void {
  const { center, r } = g;
  const glow = s.motion.serviceGlowOf(svc.id);
  const hovered = s.hovered === g.id;
  const stroke = serviceStroke(svc, glow, hovered);

  // A whisper of interior so every body has mass, not just an outline.
  const body = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r);
  body.addColorStop(0, rgba("fg", svc.status === "not-configured" ? 0.015 : 0.045));
  body.addColorStop(0.75, rgba("fg", 0.012));
  body.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = body;
  ctx.fillRect(center.x - r, center.y - r, r * 2, r * 2);

  // Active service: a soft interior light rises with real work.
  if (glow > 0.02 && svc.status === "ok") {
    const gl = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r + 10);
    gl.addColorStop(0, rgba("accent", 0.1 * glow));
    gl.addColorStop(0.7, rgba("accent", 0.05 * glow));
    gl.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gl;
    ctx.fillRect(center.x - r - 10, center.y - r - 10, (r + 10) * 2, (r + 10) * 2);
  }

  ctx.strokeStyle = rgba(stroke.token, stroke.alpha);
  ctx.lineWidth = stroke.width;
  if (svc.status === "not-configured") ctx.setLineDash([2.5, 4.5]);
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  // Identity, in one restrained grammar (spec §5):
  const rot = s.motionEnabled ? TAU * drift(s.t, 240, r) : 0;
  if (svc.id === "jellyfin") {
    // Playback: a lens — one inner ring plus a focal point.
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.62, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(svc.active ? "accent" : "fg", svc.active ? 0.8 : 0.32);
    ctx.beginPath();
    ctx.arc(center.x, center.y, 2.1, 0, TAU);
    ctx.fill();
  } else if (svc.id === "sonarr" || svc.id === "radarr") {
    // Siblings: three tiny satellites, phase-shifted so they are not twins.
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.58, 0, TAU);
    ctx.stroke();
    const phase = svc.id === "sonarr" ? 0 : Math.PI / 3;
    for (let i = 0; i < 3; i++) {
      const a = rot * 0.5 + phase + (i / 3) * TAU;
      const p = pointOnCircle(center, r * 0.58, a);
      ctx.fillStyle = rgba("fg", 0.46 + glow * 0.3);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.7, 0, TAU);
      ctx.fill();
    }
  } else if (svc.id === "qbittorrent") {
    // Downloader: denser, utilitarian — a fine inner segment ring.
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.5);
    ctx.lineWidth = 1;
    const segs = 8;
    for (let i = 0; i < segs; i++) {
      const a = rot * 0.35 + (i / segs) * TAU;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r * 0.6, a, a + (TAU / segs) * 0.55);
      ctx.stroke();
    }
  } else {
    // Requests: the quietest — a single dim mote.
    ctx.fillStyle = rgba("fg", svc.status === "neutral" ? 0.26 : 0.14);
    ctx.beginPath();
    ctx.arc(center.x, center.y, 1.5, 0, TAU);
    ctx.fill();
  }
}

// --- compute star -------------------------------------------------------------

function drawCore(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const core = s.layout.core;
  const { center } = core;
  const m = s.motion;
  const load = m.totalLoad;
  const cpuKnown = s.model.core.status === "available" || s.model.core.status === "stale";
  const dimmed = !cpuKnown;
  const stale = s.model.core.status === "stale";
  const alphaScale = stale ? 0.55 : 1;

  // 1. Outer atmospheric field — the across-the-room load signal (spec §4):
  // barely-there at idle, unmistakably fuller at heavy load.
  if (cpuKnown) {
    const fieldR = core.atmosphereR * (0.86 + 0.2 * load);
    const field = ctx.createRadialGradient(center.x, center.y, core.spokeBaseR, center.x, center.y, fieldR);
    field.addColorStop(0, rgba("accent", (0.05 + 0.16 * load) * alphaScale));
    field.addColorStop(0.6, rgba("accent", (0.02 + 0.08 * load) * alphaScale));
    field.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = field;
    ctx.fillRect(center.x - fieldR, center.y - fieldR, fieldR * 2, fieldR * 2);
  }

  // 2. Memory halo: a particulate dust torus — grains ALL the way around so
  // it always reads as one ring; the occupied fraction (from 12 o'clock)
  // carries denser, brighter grains with a soft taper at its edge, plus a
  // hairline measurement arc so the value is readable up close.
  const memFraction = m.memFraction;
  const rng = makeRng(0x3e30a11);
  const grains = 420;
  const haloRot = s.motionEnabled ? TAU * drift(s.t, 410) : 0;
  for (let i = 0; i < grains; i++) {
    const baseA = (i / grains) * TAU + rng() * 0.02;
    const a = baseA - Math.PI / 2 + haloRot;
    const rr = core.memR + (rng() - 0.5) * core.memBandW;
    const posFrac = i / grains; // 0 at 12 o'clock, clockwise
    // 0..1 how "occupied" this angular position is, tapering over ~4% of the
    // circle at the boundary so the ring never has a hard cliff.
    const occ =
      memFraction === null
        ? 0
        : Math.max(0, Math.min(1, (memFraction - posFrac) / 0.04 + 1));
    if (occ <= 0 && rng() > 0.8) continue; // the torus stays whole when free
    const p = pointOnCircle(center, rr, a);
    const alpha = (0.03 + rng() * 0.045 + occ * (0.1 + rng() * 0.1)) * alphaScale;
    ctx.fillStyle = rgba("fg", alpha);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 0.6 + rng() * 0.5 + occ * 0.55, 0, TAU);
    ctx.fill();
  }
  if (memFraction !== null) {
    ctx.strokeStyle = rgba("fg", 0.16 * alphaScale);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, core.memR + core.memBandW * 0.5 + 7, -Math.PI / 2, -Math.PI / 2 + memFraction * TAU);
    ctx.stroke();
  }
  // Swap pressure: a short warm arc riding just outside the halo — only when
  // meaningful, and always local.
  if (m.memFraction !== null && s.model.core.swapFraction !== null) {
    ctx.strokeStyle = rgba("warn", 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, core.memR + core.memBandW, -Math.PI / 2, -Math.PI / 2 + s.model.core.swapFraction * TAU);
    ctx.stroke();
  }

  // 3. Corona: one filament per REAL logical CPU (truthful count), drawn as
  // stellar prominences — seeded base-length variation and a two-pass soft +
  // bright stroke so the corona reads as matter, not a radial bar chart.
  const cores = m.perCore;
  const coronaRot = s.motionEnabled ? TAU * drift(s.t, 340) : 0;
  if (cores.length > 0) {
    const coronaRng = makeRng(0xc0207a);
    for (let i = 0; i < cores.length; i++) {
      const util = Math.min(1, cores[i]!);
      const a = (i / cores.length) * TAU - Math.PI / 2 + coronaRot;
      const baseVar = 0.16 + coronaRng() * 0.14; // organic, deterministic
      const lenF = baseVar + (1 - baseVar) * util;
      const inner = pointOnCircle(center, core.spokeBaseR - 6, a);
      const outer = pointOnCircle(center, core.spokeBaseR + core.spokeMaxLen * lenF, a);
      const grad = ctx.createLinearGradient(inner.x, inner.y, outer.x, outer.y);
      grad.addColorStop(0, rgba("fg", (0.34 + 0.5 * util) * alphaScale));
      grad.addColorStop(0.65, rgba("accent", (0.12 + 0.3 * util) * alphaScale));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      // Soft under-stroke gives the filament body; bright core gives it edge.
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.6;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(outer.x, outer.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(outer.x, outer.y);
      ctx.stroke();
    }
  } else if (dimmed) {
    // No fake corona: an honest dim shell.
    ctx.strokeStyle = rgba("hairline", 0.9);
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.arc(center.x, center.y, core.spokeBaseR, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 4. Inner core: a compact luminous disc, breathing very slowly with load.
  if (cpuKnown) {
    const breathing = s.motionEnabled ? 1 + 0.025 * (breathe(s.t, 41) - 0.5) * 2 : 1;
    const discR = core.discR * (0.94 + 0.12 * load) * breathing;
    const disc = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, discR);
    disc.addColorStop(0, rgba("fg", (0.85 + 0.13 * load) * alphaScale));
    disc.addColorStop(0.35, rgba("fg", 0.34 * alphaScale));
    disc.addColorStop(0.75, rgba("accent", 0.1 * alphaScale));
    disc.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = disc;
    ctx.fillRect(center.x - discR, center.y - discR, discR * 2, discR * 2);
  }
}

// --- debug overlay ------------------------------------------------------------

export function drawDebug(ctx: CanvasRenderingContext2D, s: RenderState, labelsBoxes: Array<{ x: number; y: number; w: number; h: number }>): void {
  const L = s.layout;
  ctx.lineWidth = 1;
  const circle = (x: number, y: number, r: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  };
  // Safe area.
  ctx.strokeStyle = "rgba(255,0,255,0.5)";
  ctx.strokeRect(L.safe.left, L.safe.top, L.world.w - L.safe.left - L.safe.right, L.world.h - L.safe.top - L.safe.bottom);
  // Lane + orbit + belt.
  circle(L.core.center.x, L.core.center.y, L.laneR, "rgba(0,255,255,0.35)");
  circle(L.core.center.x, L.core.center.y, L.serviceOrbitR, "rgba(0,255,128,0.35)");
  circle(L.core.center.x, L.core.center.y, L.core.boundaryR, "rgba(255,64,64,0.5)");
  // Bodies: hard radius + atmosphere + center.
  const bodies: BodyGeom[] = [...L.services.values(), ...L.storage.values()];
  if (L.genericStorage) bodies.push(L.genericStorage);
  for (const b of bodies) {
    circle(b.center.x, b.center.y, b.r, "rgba(255,255,0,0.6)");
    circle(b.center.x, b.center.y, b.atmosphereR, "rgba(255,255,0,0.25)");
    ctx.fillStyle = "rgba(255,255,0,0.8)";
    ctx.fillRect(b.center.x - 1.5, b.center.y - 1.5, 3, 3);
  }
  // Flow ports + samples.
  for (const { geom } of s.flows) {
    ctx.fillStyle = "rgba(255,0,0,0.9)";
    for (const port of [geom.ports.from, geom.ports.to]) {
      ctx.beginPath();
      ctx.arc(port.x, port.y, 2.4, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,128,0,0.5)";
    strokePath(ctx, geom);
  }
  // Label boxes.
  ctx.strokeStyle = "rgba(128,128,255,0.6)";
  for (const b of labelsBoxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
}

// --- top-level ----------------------------------------------------------------

export function renderScene(ctx: CanvasRenderingContext2D, cam: Camera, s: RenderState): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cam.w, cam.h);
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.ox, cam.oy);
  ctx.lineCap = "round";

  drawBackground(ctx, s);
  drawGuides(ctx, s);
  drawNetworkArc(ctx, s);
  drawFlows(ctx, s);
  drawDockerBelt(ctx, s);
  for (const pool of s.model.storage) {
    const g = s.layout.storage.get(pool.name);
    if (g) drawStorageBody(ctx, s, pool, g);
  }
  drawGenericStorage(ctx, s);
  for (const svc of s.model.services) {
    const g = s.layout.services.get(svc.id);
    if (g) drawServiceBody(ctx, s, svc, g);
  }
  drawCore(ctx, s);
}
