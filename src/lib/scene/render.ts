/**
 * Scene renderer (PLA-266 rebuild) — Canvas 2D draw pass.
 *
 * Pure drawing: no React, no timers, no allocation-heavy per-frame work. The
 * host component owns the rAF loop, the camera, and the DOM overlay; this
 * module turns (model, layout, motion, t) into pixels, in world units under a
 * single transform.
 *
 * Layer order (spec §29 — composition first, polish last):
 *   1 background field        4 flows (dormant, then live)   7 compute star
 *   2 orbit guides            5 docker belt
 *   3 network boundary        6 bodies (storage, services)
 *
 * FLOW LANGUAGE (PLA-266 v2). Three relationship classes render differently:
 *   data-plane   luminous tunnels — width/glow/particle density from the
 *                log-scaled measured/derived rate; cyan = inward (downloads,
 *                writes), violet = outward (uploads, playback egress);
 *   control      thin silver signal paths with discrete traveling pulses —
 *                never throughput-sized;
 *   state-only   a breathing thin path: work exists, rate unknown — width
 *                must never imply throughput.
 * Evidence quality softens the treatment (derived < measured); stale or
 * removed overlays release to quiet immediately (no particles, pulses, or
 * endpoint excitation), and unavailable draws nothing beyond the dormant
 * structural route.
 *
 * Ambient motion uses long incommensurate periods (41 s, 73 s, 127 s) so idle
 * never reads as a loop; everything is a pure function of `t` — particles have
 * no mutable state, so the global particle budget is a hard cap by
 * construction, not a hope.
 */

import { colorTokens, type ColorTokenName } from "@/lib/design/tokens";
import { pointAtLength, pointOnCircle, tangentAtLength, TAU } from "@/lib/scene/geom";
import { containerHash } from "@/lib/scene/layout";
import { makeRng } from "@/lib/scene/rng";
import { intensityFromRate, particlePeriodSeconds } from "@/lib/topology/smoothing";
import type { BackgroundField } from "@/lib/scene/background";
import type { BodyGeom, SceneLayout } from "@/lib/scene/layout";
import type {
  DockerContainerModel,
  SceneModel,
  ServiceBodyModel,
  StorageBodyModel,
} from "@/lib/scene/model";
import type { SceneMotion, LiveFlow } from "@/lib/scene/motion";
import type { FlowGeom } from "@/lib/scene/routing";
import type { ChannelRole, FlowChannel } from "@/lib/topology/activity";

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
  live: LiveFlow;
}

export interface RenderState {
  model: SceneModel;
  layout: SceneLayout;
  flows: LiveFlowGeom[];
  /** Faint structural routes drawn under everything (also when idle). */
  dormant: FlowGeom[];
  motion: SceneMotion;
  background: BackgroundField;
  /** Hovered body or flow id (flows use their observation id). */
  hovered: string | null;
  /** Seconds since mount (frozen renders pass a fixed value). */
  t: number;
  /** False = reduced motion / frozen: static composition, no drift/packets. */
  motionEnabled: boolean;
  /** Offscreen layer cache — required for the 24/7 idle CPU budget. */
  cache: RenderCache;
}

/**
 * Offscreen layer cache (spec §23). The scene runs for days: everything that
 * does not change per frame — the ground gradients, star layers, each storage
 * body's surface speckle, the memory dust torus — is rendered ONCE into
 * offscreen canvases and blitted per frame. Keys encode every input that can
 * change the pixels, so data changes invalidate exactly the right layer.
 */
export interface RenderCache {
  layers: Map<string, { key: string; canvas: HTMLCanvasElement }>;
}

export function makeRenderCache(): RenderCache {
  return { layers: new Map() };
}

/** Get-or-render an offscreen canvas layer. */
function layer(
  cache: RenderCache,
  id: string,
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  const entry = cache.layers.get(id);
  if (entry && entry.key === key) return entry.canvas;
  const canvas = entry?.canvas ?? document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  draw(ctx);
  cache.layers.set(id, { key, canvas });
  return canvas;
}

function rgba(token: ColorTokenName, alpha: number): string {
  const [r, g, b] = colorTokens[token];
  return `rgba(${r},${g},${b},${alpha})`;
}

function mixRgba(
  left: ColorTokenName,
  right: ColorTokenName,
  alpha: number,
  weight = 0.5,
): string {
  const [lr, lg, lb] = colorTokens[left];
  const [rr, rg, rb] = colorTokens[right];
  const t = Math.max(0, Math.min(1, weight));
  const u = 1 - t;
  return `rgba(${lr * u + rr * t},${lg * u + rg * t},${lb * u + rb * t},${alpha})`;
}

/** Slow ambient phase in [0,1) with a long, non-looping feel. */
function drift(t: number, periodS: number, phase = 0): number {
  return ((t / periodS + phase) % 1 + 1) % 1;
}

function breathe(t: number, periodS: number, phase = 0): number {
  return 0.5 + 0.5 * Math.sin(TAU * drift(t, periodS, phase));
}

// --- flow style ---------------------------------------------------------------

/**
 * The tunable tunnel treatment. The flow laboratory (dev-only) renders the
 * same drawing code under alternative styles; production ships exactly ONE —
 * `PRODUCTION_FLOW_STYLE`, chosen in the PLA-266 v2 design study for the best
 * balance of readability, restraint, and idle elegance.
 */
export interface FlowStyle {
  /** Outer atmospheric glow width, as a multiple of core width. */
  glowScale: number;
  /** Peak glow alpha at full intensity. */
  glowAlpha: number;
  /** Translucent tunnel body alpha at full intensity. */
  bodyAlpha: number;
  /** Inner highlight: a bright centerline, twin edge rails, or both. */
  highlight: "center" | "rails" | "both";
  /** Particle rendering: tapered streaks or plain points. */
  particle: "streak" | "point";
  /** Hard global particle cap across every flow and channel. */
  particleBudget: number;
}

export const PRODUCTION_FLOW_STYLE: FlowStyle = {
  glowScale: 3.4,
  glowAlpha: 0.1,
  bodyAlpha: 0.15,
  highlight: "center",
  particle: "streak",
  particleBudget: 72,
};

const roleToken = (role: ChannelRole): ColorTokenName =>
  role === "ingress" || role === "write" ? "flow-in" : "flow-out";

function strokeSampled(ctx: CanvasRenderingContext2D, geom: FlowGeom): void {
  const pts = geom.path.points;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.stroke();
}

/** Stroke the path offset sideways by `off` world units (screen-left of travel). */
function strokeOffset(ctx: CanvasRenderingContext2D, geom: FlowGeom, off: number): void {
  const { points } = geom.path;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[Math.min(i + 1, points.length - 1)]!;
    const o = points[Math.max(i - 1, 0)]!;
    const tx = q.x - o.x;
    const ty = q.y - o.y;
    const len = Math.hypot(tx, ty) || 1;
    const x = p.x + (-ty / len) * off;
    const y = p.y + (tx / len) * off;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// --- background ---------------------------------------------------------------

/**
 * Ground + star layers are pre-rendered per canvas size and blitted; only the
 * (cheap) vignette gradient and the sub-pixel parallax offsets happen per
 * frame. This is the difference between a 24/7-viable idle CPU cost and
 * redrawing hundreds of gradients and dots every frame.
 */
function drawBackground(ctx: CanvasRenderingContext2D, cam: Camera, s: RenderState): void {
  const { w, h } = s.layout.world;
  const core = s.layout.core.center;
  const sizeKey = `${cam.w}x${cam.h}:${w.toFixed(1)}`;
  const worldTransform = (g: CanvasRenderingContext2D) =>
    g.setTransform(cam.scale, 0, 0, cam.scale, cam.ox, cam.oy);

  const ground = layer(s.cache, "ground", sizeKey, cam.w, cam.h, (g) => {
    worldTransform(g);
    // Deep ground with the faintest center lift so black never reads as void.
    g.fillStyle = rgba("bg", 1);
    g.fillRect(0, 0, w, h);
    const lift = g.createRadialGradient(core.x, core.y, 0, core.x, core.y, h * 0.9);
    lift.addColorStop(0, "rgba(30,36,52,0.32)");
    lift.addColorStop(0.55, "rgba(18,22,33,0.12)");
    lift.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = lift;
    g.fillRect(0, 0, w, h);
    for (const d of s.background.dust) {
      const grad = g.createRadialGradient(d.x * w, d.y * h, 0, d.x * w, d.y * h, d.r * w);
      grad.addColorStop(0, rgba("accent", d.alpha));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(d.x * w - d.r * w, d.y * h - d.r * w, d.r * w * 2, d.r * w * 2);
    }
  });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(ground, 0, 0);

  s.background.layers.forEach((starLayer, i) => {
    const canvas = layer(s.cache, `stars${i}`, sizeKey, cam.w, cam.h, (g) => {
      worldTransform(g);
      g.fillStyle = rgba("fg", 1);
      for (const star of starLayer.stars) {
        g.globalAlpha = star.alpha;
        g.beginPath();
        g.arc(star.x * w, star.y * h, star.r, 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
    });
    const ox = s.motionEnabled ? Math.sin(TAU * drift(s.t, 127)) * 4 * starLayer.drift * cam.scale : 0;
    const oy = s.motionEnabled ? Math.cos(TAU * drift(s.t, 173)) * 2.6 * starLayer.drift * cam.scale : 0;
    ctx.drawImage(canvas, ox, oy);
  });

  // Vignette, live (one gradient fill).
  worldTransform(ctx);
  const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, h * 0.95);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.42)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
}

// --- guides -------------------------------------------------------------------

function drawGuides(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { core, serviceOrbitR } = s.layout;
  // Service orbit: a faint guide arc spanning just beyond the service crescent.
  ctx.strokeStyle = rgba("hairline", 0.34);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(core.center.x, core.center.y, serviceOrbitR, (72 * Math.PI) / 180, (280 * Math.PI) / 180);
  ctx.stroke();
}

// --- network boundary + gateway -----------------------------------------------

function drawNetworkArc(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const arc = s.layout.networkArc;
  const gw = s.layout.gateway;
  const known =
    s.model.network.status === "available" &&
    (s.model.network.rxBps !== null || s.model.network.txBps !== null);
  const rx = s.motion.rxNorm;
  const tx = s.motion.txNorm;

  // The boundary, drawn as two arcs leaving an aperture gap at the gateway —
  // the one place traffic crosses the edge of the system.
  const gap = 26 / arc.r; // ~26 world units of opening
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = rgba("border", 0.8);
  ctx.beginPath();
  ctx.arc(arc.center.x, arc.center.y, arc.r, arc.a0, gw.angle - gap);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(arc.center.x, arc.center.y, arc.r, gw.angle + gap, arc.a1);
  ctx.stroke();

  // Aperture structure: two portal ticks bracketing the opening, plus a quiet
  // outer marker — the gateway reads as an instrument, not a broken line.
  ctx.strokeStyle = rgba("border", 0.95);
  ctx.lineWidth = 1.4;
  for (const edge of [gw.angle - gap, gw.angle + gap]) {
    const p0 = pointOnCircle(arc.center, arc.r - 9, edge);
    const p1 = pointOnCircle(arc.center, arc.r + 9, edge);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  const marker = pointOnCircle(arc.center, arc.r + 16, gw.angle);
  ctx.strokeStyle = rgba("hairline", 0.9);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(marker.x, marker.y, 3.2, 0, TAU);
  ctx.stroke();

  // Live aperture energy: rx lights the inner lip (traffic entering), tx the
  // outer lip — directional color, only when the counters are actually known.
  if (known && (rx > 0.004 || tx > 0.004)) {
    const pulse = s.motionEnabled ? 0.85 + 0.15 * breathe(s.t, 9) : 1;
    if (rx > 0.004) {
      const g = ctx.createRadialGradient(gw.point.x, gw.point.y, 0, gw.point.x, gw.point.y, 30);
      g.addColorStop(0, rgba("flow-in", (0.1 + 0.4 * Math.min(1, rx * 3)) * pulse));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(gw.point.x - 30, gw.point.y - 30, 60, 60);
    }
    if (tx > 0.004) {
      const out = pointOnCircle(arc.center, arc.r + 10, gw.angle);
      const g = ctx.createRadialGradient(out.x, out.y, 0, out.x, out.y, 24);
      g.addColorStop(0, rgba("flow-out", (0.08 + 0.36 * Math.min(1, tx * 3)) * pulse));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(out.x - 24, out.y - 24, 48, 48);
    }
  }

  // Boundary ticks: quiet punctuation marking the rim as an instrument.
  ctx.strokeStyle = rgba("hairline", 0.6);
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const a = arc.a0 + ((arc.a1 - arc.a0) * i) / 8;
    if (Math.abs(a - gw.angle) < gap * 1.6) continue; // keep the aperture clean
    const p0 = pointOnCircle(arc.center, arc.r - 4, a);
    const p1 = pointOnCircle(arc.center, arc.r + (i % 4 === 0 ? 9 : 5), a);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
}

// --- flows --------------------------------------------------------------------

/** Faint structural routes: the topology exists even when nothing moves. */
function drawDormantRoutes(ctx: CanvasRenderingContext2D, s: RenderState): void {
  ctx.lineWidth = 1;
  for (const geom of s.dormant) {
    // Routes with a live counterpart are skipped — the tunnel replaces them.
    if (s.flows.some((f) => samePath(f.geom, geom))) continue;
    ctx.strokeStyle = rgba("hairline", 0.22);
    strokeSampled(ctx, geom);
  }
}

function samePath(a: FlowGeom, b: FlowGeom): boolean {
  // Same route class if both endpoints coincide (dormant ids differ from live).
  const pa = a.ports;
  const pb = b.ports;
  const near = (u: { x: number; y: number }, v: { x: number; y: number }) =>
    Math.abs(u.x - v.x) < 2 && Math.abs(u.y - v.y) < 2;
  return (near(pa.from, pb.from) && near(pa.to, pb.to)) || (near(pa.from, pb.to) && near(pa.to, pb.from));
}

interface ChannelDraw {
  role: ChannelRole;
  direction: "forward" | "reverse";
  bps: number | null;
  width: number;
}

function liveChannels(f: LiveFlowGeom): ChannelDraw[] {
  const { obs } = f.live;
  const out: ChannelDraw[] = [];
  for (const ch of obs.channels) {
    const width = ch.direction === "forward" ? f.live.forwardWidth : f.live.reverseWidth;
    out.push({ role: ch.role, direction: ch.direction, bps: ch.bytesPerSecond, width });
  }
  return out;
}

function channelVisible(ch: Pick<ChannelDraw, "width" | "bps">): boolean {
  return ch.width > 0.05 || (ch.bps ?? 0) > 0;
}

export function tunnelBodyIsBidirectional(
  channels: ReadonlyArray<Pick<ChannelDraw, "direction" | "width" | "bps">>,
): boolean {
  const visible = channels.filter(channelVisible);
  return (
    visible.some((channel) => channel.direction === "forward") &&
    visible.some((channel) => channel.direction === "reverse")
  );
}

function endpointTokenForDirection(
  channel: Pick<FlowChannel, "role"> | undefined,
  fallback: ColorTokenName,
): ColorTokenName {
  return channel ? roleToken(channel.role) : fallback;
}

export function tunnelEndpointTokens(
  channels: ReadonlyArray<Pick<FlowChannel, "direction" | "role">>,
  fallback: ColorTokenName,
): { from: ColorTokenName; to: ColorTokenName } {
  const forward = channels.find((c) => c.direction === "forward");
  const reverse = channels.find((c) => c.direction === "reverse");
  if (forward && reverse) {
    return {
      from: endpointTokenForDirection(reverse, fallback),
      to: endpointTokenForDirection(forward, fallback),
    };
  }
  const single = forward ?? reverse;
  const token = endpointTokenForDirection(single, fallback);
  return { from: token, to: token };
}

export function flowOverlayIsLive(live: LiveFlow): boolean {
  return live.present && live.obs.freshness === "live";
}

/**
 * Deterministic particle pass for one channel. Positions are pure functions
 * of `t`; `budget` is decremented and enforced globally.
 */
function drawChannelParticles(
  ctx: CanvasRenderingContext2D,
  geom: FlowGeom,
  ch: ChannelDraw,
  opts: {
    t: number;
    style: FlowStyle;
    alphaScale: number;
    densityScale: number;
    bidirectional: boolean;
    bodyWidth: number;
    budget: { left: number };
  },
): void {
  if (ch.bps === null) return;
  const { t, style, alphaScale, densityScale, bidirectional, bodyWidth } = opts;
  const L = geom.path.totalLength;
  const intensity = intensityFromRate(ch.bps);
  if (intensity <= 0) return;
  const period = particlePeriodSeconds(ch.bps);
  const speed = 30 + 95 * intensity; // world units / s — deliberately calm
  const spacing = Math.max(26, speed * period);
  let count = Math.max(1, Math.min(14, Math.round((L / spacing) * densityScale)));
  count = Math.min(count, opts.budget.left);
  if (count <= 0) return;
  opts.budget.left -= count;

  const token = roleToken(ch.role);
  // Opposite-direction populations sit slightly off the centerline so both
  // stay readable on one shared conduit.
  const offset = bidirectional
    ? (ch.direction === "forward" ? -1 : 1) * (bodyWidth * 0.3 + 0.9)
    : 0;
  const streak = Math.min(30, 10 + 20 * intensity);
  const rng = makeRng(hashId(geom.flow.id) ^ (ch.direction === "forward" ? 0x51 : 0xa3));
  for (let i = 0; i < count; i++) {
    const jitter = rng() * spacing;
    const raw = (t * speed + i * spacing + jitter) % L;
    const head = ch.direction === "forward" ? raw : L - raw;
    const tail = ch.direction === "forward" ? Math.max(0, head - streak) : Math.min(L, head + streak);
    const p = offsetPoint(geom, head, offset);
    const brightness = 0.75 + 0.25 * rng();
    if (opts.style.particle === "streak") {
      const q = offsetPoint(geom, tail, offset);
      const grad = ctx.createLinearGradient(q.x, q.y, p.x, p.y);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, rgba(token, (0.3 + 0.45 * intensity) * alphaScale * brightness));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    // A tiny bright head — a bit of matter, not confetti.
    ctx.fillStyle = rgba(token, (0.4 + 0.4 * intensity) * alphaScale * brightness);
    ctx.beginPath();
    ctx.arc(p.x, p.y, style.particle === "point" ? 1.5 : 1.15, 0, TAU);
    ctx.fill();
  }
  void style;
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h >>> 0;
}

function offsetPoint(geom: FlowGeom, d: number, off: number): { x: number; y: number } {
  const p = pointAtLength(geom.path, d);
  if (off === 0) return p;
  const tan = tangentAtLength(geom.path, d);
  return { x: p.x - tan.y * off, y: p.y + tan.x * off };
}

/** Static direction chevrons for reduced-motion rendering. */
function drawStaticDirection(
  ctx: CanvasRenderingContext2D,
  geom: FlowGeom,
  ch: ChannelDraw,
  alphaScale: number,
  bidirectional: boolean,
  bodyWidth: number,
): void {
  const L = geom.path.totalLength;
  const n = Math.max(2, Math.min(6, Math.floor(L / 130)));
  const token = roleToken(ch.role);
  const offset = bidirectional ? (ch.direction === "forward" ? -1 : 1) * (bodyWidth * 0.3 + 0.9) : 0;
  ctx.strokeStyle = rgba(token, 0.55 * alphaScale);
  ctx.lineWidth = 1.3;
  for (let i = 1; i <= n; i++) {
    const d = (L * i) / (n + 1);
    const p = offsetPoint(geom, d, offset);
    let tan = tangentAtLength(geom.path, d);
    if (ch.direction === "reverse") tan = { x: -tan.x, y: -tan.y };
    const back = 4.4;
    const side = 2.8;
    ctx.beginPath();
    ctx.moveTo(p.x - tan.x * back - tan.y * side, p.y - tan.y * back + tan.x * side);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(p.x - tan.x * back + tan.y * side, p.y - tan.y * back - tan.x * side);
    ctx.stroke();
  }
}

/**
 * The minimal drawing environment for one flow — split from RenderState so
 * the dev flow laboratory can exercise the EXACT production drawing code on
 * synthetic observations.
 */
export interface FlowDrawEnv {
  t: number;
  motionEnabled: boolean;
  hovered: string | null;
}

/**
 * One data-plane tunnel: structural path → atmospheric glow → translucent
 * body → inner highlight → directional particles → endpoint port glows.
 * The static composition (everything but particles) must be beautiful with
 * animation paused — reduced-motion swaps particles for direction chevrons.
 */
export function drawTunnel(
  ctx: CanvasRenderingContext2D,
  s: FlowDrawEnv,
  f: LiveFlowGeom,
  style: FlowStyle,
  budget: { left: number },
): void {
  const { geom, live } = f;
  const { obs } = live;
  const overlayLive = flowOverlayIsLive(live);
  const hovered = s.hovered === obs.id;
  const width = live.width;
  const channels = liveChannels(f);
  const activeChannels = channels.filter(channelVisible);
  const bidirectional = tunnelBodyIsBidirectional(channels);

  // Evidence encoding: derived flows are softer; stale/removed flows are dim
  // release ghosts whose body may ease away without implying current work.
  const evidenceScale = obs.evidence === "measured" ? 1 : 0.78;
  const alphaScale = (!overlayLive ? 0.42 : 1) * evidenceScale * (hovered ? 1.25 : 1);
  const densityScale = obs.evidence === "measured" ? 1 : 0.6;

  // Dominant direction decides the body tint; a genuinely bidirectional
  // conduit blends toward neutral so neither direction lies.
  const fw = live.forwardWidth;
  const rv = live.reverseWidth;
  const fToken = roleToken(channels.find((c) => c.direction === "forward")?.role ?? "ingress");
  const rToken = roleToken(channels.find((c) => c.direction === "reverse")?.role ?? "egress");
  const bodyToken: ColorTokenName = fw >= rv ? fToken : rToken;
  const endpointTokens = tunnelEndpointTokens(activeChannels, bodyToken);

  if (width > 0.05) {
    const intensity = Math.min(1, width / 10);
    // 1. Outer atmospheric glow.
    ctx.strokeStyle = bidirectional
      ? mixRgba("flow-in", "flow-out", style.glowAlpha * (0.35 + 0.65 * intensity) * alphaScale)
      : rgba(bodyToken, style.glowAlpha * (0.35 + 0.65 * intensity) * alphaScale);
    ctx.lineWidth = Math.max(width * style.glowScale, width + 6);
    strokeSampled(ctx, geom);
    // 2. Translucent tunnel body.
    ctx.strokeStyle = bidirectional
      ? mixRgba("flow-in", "flow-out", style.bodyAlpha * (0.5 + 0.5 * intensity) * alphaScale)
      : rgba(bodyToken, style.bodyAlpha * (0.5 + 0.5 * intensity) * alphaScale);
    ctx.lineWidth = width;
    strokeSampled(ctx, geom);
    // 3. Inner highlight(s).
    if (style.highlight !== "rails") {
      ctx.strokeStyle = bidirectional
        ? mixRgba("flow-in", "flow-out", (0.3 + 0.28 * intensity) * alphaScale)
        : rgba(bodyToken, (0.3 + 0.28 * intensity) * alphaScale);
      ctx.lineWidth = 1;
      strokeSampled(ctx, geom);
    }
    if (style.highlight !== "center") {
      ctx.strokeStyle = bidirectional
        ? mixRgba("flow-in", "flow-out", (0.16 + 0.2 * intensity) * alphaScale)
        : rgba(bodyToken, (0.16 + 0.2 * intensity) * alphaScale);
      ctx.lineWidth = 0.8;
      strokeOffset(ctx, geom, width * 0.5);
      strokeOffset(ctx, geom, -width * 0.5);
    }

    // 4. Directional matter.
    if (overlayLive) {
      if (s.motionEnabled) {
        for (const ch of channels) {
          drawChannelParticles(ctx, geom, ch, {
            t: s.t,
            style,
            alphaScale,
            densityScale,
            bidirectional,
            bodyWidth: width,
            budget,
          });
        }
      } else {
        for (const ch of channels) {
          if ((ch.bps ?? 0) > 0 || ch.width > 0.05) {
            drawStaticDirection(ctx, geom, ch, alphaScale, bidirectional, width);
          }
        }
      }
    }

    // 5. Endpoint port glows — energy entering/leaving a body. Only genuinely
    // live overlays may excite endpoints.
    if (overlayLive) {
      const portR = 5 + Math.min(6, width * 0.7);
      const pulse = s.motionEnabled ? 0.82 + 0.18 * breathe(s.t, 7, hashId(obs.id) % 5) : 1;
      for (const [port, token] of [
        [geom.ports.to, endpointTokens.to],
        [geom.ports.from, endpointTokens.from],
      ] as const) {
        const g = ctx.createRadialGradient(port.x, port.y, 0, port.x, port.y, portR);
        g.addColorStop(0, rgba(token, (0.1 + 0.32 * Math.min(1, width / 8)) * alphaScale * pulse));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(port.x - portR, port.y - portR, portR * 2, portR * 2);
      }
    }
    return;
  }

  // State-only data-plane activity (rate unknown): a thin breathing path —
  // present, honest, and deliberately NOT sized like throughput.
  if (live.activity > 0.02) {
    const breatheA = !overlayLive || !s.motionEnabled
      ? 0.6
      : 0.45 + 0.55 * breathe(s.t, 5.5, hashId(obs.id) % 7);
    ctx.strokeStyle = rgba(bodyToken, 0.24 * live.activity * breatheA * alphaScale);
    ctx.lineWidth = 1.2;
    strokeSampled(ctx, geom);
  }
}

/**
 * Control-plane signal: a quiet silver filament with a discrete traveling
 * pulse — deliberately incapable of reading as a data tunnel.
 */
export function drawControlSignal(
  ctx: CanvasRenderingContext2D,
  s: FlowDrawEnv,
  f: LiveFlowGeom,
): void {
  const { geom, live } = f;
  const overlayLive = flowOverlayIsLive(live);
  const stale = live.obs.freshness === "stale";
  const hovered = s.hovered === live.obs.id;
  const a = live.activity * (stale ? 0.4 : 1) * (hovered ? 1.5 : 1);
  if (a <= 0.02) return;
  ctx.strokeStyle = rgba("flow-ctl", 0.16 * a);
  ctx.lineWidth = 1;
  strokeSampled(ctx, geom);

  // One discrete pulse every few seconds (deterministic phase per flow) —
  // an instruction traveling, not a byte stream. Reduced-motion gets a
  // static midpoint bead; stale/removed overlays stay quiet.
  const L = geom.path.totalLength;
  if (s.motionEnabled && overlayLive) {
    const periodS = 4.2;
    const phase = drift(s.t, periodS, (hashId(live.obs.id) % 100) / 100);
    const visible = phase < 0.34; // pulse travels, then the lane rests
    if (visible) {
      const d = (phase / 0.34) * L;
      const p = pointAtLength(geom.path, d);
      const fade = Math.sin(Math.PI * (phase / 0.34));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 5);
      g.addColorStop(0, rgba("flow-ctl", 0.55 * a * fade));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
    }
  } else if (!s.motionEnabled && overlayLive) {
    const p = pointAtLength(geom.path, L * 0.5);
    ctx.fillStyle = rgba("flow-ctl", 0.35 * a);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.4, 0, TAU);
    ctx.fill();
  }
}

function drawFlows(ctx: CanvasRenderingContext2D, s: RenderState, style: FlowStyle): void {
  const budget = { left: style.particleBudget };
  // Data-plane first (tunnels under signals reads better at crossings).
  for (const f of s.flows) {
    if (f.live.obs.plane === "data") drawTunnel(ctx, s, f, style, budget);
  }
  for (const f of s.flows) {
    if (f.live.obs.plane === "control") drawControlSignal(ctx, s, f);
  }
}

// --- container asteroid field -------------------------------------------------

/**
 * Deterministic ambient-drift phase from the FULL container name (the shared
 * stable FNV-1a hash). Names of equal length sharing a first letter must not
 * synchronize — the previous `length + firstCharCode` seed made e.g.
 * "sonarr"/"seerrr" twins (V2.1 phase blocker).
 */
export function containerMotionPhase(name: string): number {
  return makeRng(containerHash(name))() * TAU;
}

export function containerMotionOffset(
  container: DockerContainerModel,
  t: number,
  motionEnabled: boolean,
  phase = 0,
): { x: number; y: number } {
  // Stale or metric-less containers must sit perfectly still: motion is an
  // activity claim, and unknown metrics support no such claim (PLA-273).
  if (
    !motionEnabled ||
    container.freshness !== "live" ||
    container.metricCoverage === "unavailable"
  ) {
    return { x: 0, y: 0 };
  }
  // Motion energy is WORK (CPU + network + block I/O), never memory
  // residency: a large idle process keeps its size but not a drift. Null
  // metrics contribute zero — no unsupported movement (V2.1 motion truth).
  const energy = container.workScore;
  return {
    x: Math.cos(t / 19 + phase) * energy * 2.4,
    y: Math.sin(t / 23 + phase) * energy * 2.4,
  };
}

/**
 * Pure stroke/dash decision for a container body — exported so the unknown ≠
 * idle distinction is unit-testable without rasterizing. Confirmed-idle bodies
 * keep a solid quiet outline; metric-less bodies get a NEUTRAL dashed static
 * treatment (distinct from the tighter dash of an unknown-STATE container).
 */
export function containerStrokeTreatment(container: DockerContainerModel): {
  token: ColorTokenName;
  dash: number[] | null;
} {
  if (container.bad) return { token: "danger", dash: null };
  if (container.unverified) return { token: "faint", dash: [2, 2] };
  if (container.metricCoverage === "unavailable") return { token: "muted", dash: [4, 3] };
  return { token: "fg", dash: null };
}

function drawContainerAsteroid(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  container: DockerContainerModel,
  geom: BodyGeom,
): void {
  const live = container.freshness === "live";
  const stale = container.freshness === "stale";
  const energy = live ? Math.max(container.resourceScore, container.ioIntensity) : 0;
  const phase = containerMotionPhase(container.name);
  const offset = containerMotionOffset(container, s.t, s.motionEnabled, phase);
  const cx = geom.center.x + offset.x;
  const cy = geom.center.y + offset.y;
  const r = geom.r;
  const hovered = s.hovered === geom.id;

  if (live && container.ioIntensity > 0.02) {
    const net = (container.netRxBps ?? 0) + (container.netTxBps ?? 0);
    const block = (container.blockReadBps ?? 0) + (container.blockWriteBps ?? 0);
    if (net > 0) {
      ctx.strokeStyle = rgba("flow-in", 0.12 + container.ioIntensity * 0.22);
      ctx.lineWidth = 1 + container.ioIntensity * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4 + container.ioIntensity * 5, -Math.PI * 0.9, Math.PI * 0.15);
      ctx.stroke();
    }
    if (block > 0) {
      ctx.strokeStyle = rgba("flow-out", 0.1 + container.ioIntensity * 0.2);
      ctx.lineWidth = 1 + container.ioIntensity * 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 7 + container.ioIntensity * 7, Math.PI * 0.15, Math.PI * 1.05);
      ctx.stroke();
    }
  }

  const metricsUnknown =
    container.metricCoverage === "unavailable" && !container.bad && !container.unverified;
  const alpha = stale
    ? 0.24
    : container.bad
      ? 0.78
      : metricsUnknown
        ? 0.42 // quiet but present — NOT the dimmer confirmed-idle floor
        : 0.3 + energy * 0.32;
  const treatment = containerStrokeTreatment(container);
  ctx.fillStyle = rgba(
    treatment.token,
    container.unverified ? 0.05 : metricsUnknown ? 0.03 : alpha * 0.45,
  );
  ctx.strokeStyle = rgba(treatment.token, container.unverified ? 0.55 : alpha);
  ctx.lineWidth = container.bad ? 1.8 : 1;
  if (treatment.dash) ctx.setLineDash(treatment.dash);
  ctx.beginPath();
  if (container.bad) {
    // Angular silhouette distinguishes stopped/unhealthy state without color.
    for (let i = 0; i < 6; i++) {
      const a = phase + (i / 6) * TAU;
      const rr = r * (i % 2 === 0 ? 1 : 0.72);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, r, 0, TAU);
  }
  ctx.fill();
  ctx.stroke();
  if (treatment.dash) ctx.setLineDash([]);

  if (hovered || container.bad) {
    ctx.fillStyle = rgba(container.bad ? "danger" : "muted", stale ? 0.5 : 0.82);
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(container.name, cx, cy + r + 16);
  }
}

function drawDockerBelt(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const docker = s.model.docker;
  if (docker.status === "not-configured") return;
  const belt = s.layout.dockerBelt;
  if (docker.status === "unavailable" || docker.containers.length === 0) {
    // Honest absence: a whisper of the field boundary, no fabricated bodies.
    ctx.strokeStyle = rgba("hairline", 0.3);
    ctx.setLineDash([2, 7]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(belt.center.x, belt.center.y, belt.r, belt.a0, belt.a1);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  for (const container of docker.containers) {
    const geom = s.layout.containerField.get(container.name);
    if (geom) drawContainerAsteroid(ctx, s, container, geom);
  }
  if (s.layout.containerOverflow && s.layout.containerOverflowCount > 0) {
    const { center, r } = s.layout.containerOverflow;
    ctx.fillStyle = rgba("surface-2", 0.8);
    ctx.strokeStyle = rgba("muted", 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba("fg", 0.8);
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`+${s.layout.containerOverflowCount}`, center.x, center.y);
    ctx.textBaseline = "alphabetic";
  }
}

// --- storage bodies -----------------------------------------------------------

function drawStorageBody(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  pool: StorageBodyModel,
  g: BodyGeom,
  pixelScale: number,
): void {
  const { center, r } = g;
  const fill = s.motion.storageFillOf(pool.name) ?? pool.capacityFraction;
  const io = s.motion.storageIoOf(pool.name);
  const hovered = s.hovered === g.id;
  const toneToken: ColorTokenName =
    pool.capacityTone === "critical" ? "danger" : pool.capacityTone === "warn" ? "warn" : "fg";

  // Atmosphere: a soft halo giving the body mass. LIVE I/O breathes through
  // the atmosphere in the directional palette — cyan while absorbing writes,
  // violet while serving reads (never the capacity amber/red); unhealthy
  // pools carry a local red cast — the warning lives on the object (spec §16).
  // `io` is already gated to live telemetry by the motion system: stale or
  // unknown I/O has released to zero here.
  const writeDominant = (pool.writeBps ?? 0) > (pool.readBps ?? 0);
  const haloToken: ColorTokenName = !pool.healthy
    ? "danger"
    : io > 0.02
      ? writeDominant
        ? "flow-in"
        : "flow-out"
      : "accent";
  const haloPeak = !pool.healthy ? 0.11 : 0.04 + 0.08 * io;
  const halo = ctx.createRadialGradient(center.x, center.y, r * 0.6, center.x, center.y, g.atmosphereR + 10);
  const limbT = (r - r * 0.6) / (g.atmosphereR + 10 - r * 0.6);
  halo.addColorStop(0, rgba(haloToken, haloPeak * 0.22)); // faint interior cast
  halo.addColorStop(Math.min(0.9, limbT), rgba(haloToken, haloPeak)); // peak at limb
  halo.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(center.x - g.atmosphereR - 12, center.y - g.atmosphereR - 12, (g.atmosphereR + 12) * 2, (g.atmosphereR + 12) * 2);

  // Interior: deterministic surface speckle whose density follows occupancy,
  // fading toward the limb so the disc reads as a body with a surface rather
  // than a noise-filled circle. Pre-rendered per pool (re-rendered only when
  // occupancy moves ≥2%) and blitted with a slow rotation transform.
  let seed = 0;
  for (let i = 0; i < pool.name.length; i++) seed = (seed * 31 + pool.name.charCodeAt(i)) | 0;
  const side = r * 2;
  const ps = pixelScale;
  const fillQ = Math.round(fill * 50); // 2% quanta
  const disc = layer(
    s.cache,
    `pool:${pool.name}`,
    `${fillQ}:${r}:${hovered ? 1 : 0}:${ps.toFixed(2)}`,
    side * ps,
    side * ps,
    (g2) => {
      g2.setTransform(ps, 0, 0, ps, r * ps, r * ps);
      const rng = makeRng(seed ^ 0x5a17);
      const speckles = Math.round((r * r) / 40);
      for (let i = 0; i < speckles; i++) {
        const ang = rng() * TAU;
        const rad = Math.sqrt(rng()) * (r - 4);
        const within = rng() < 0.18 + (fillQ / 50) * 0.6; // density ∝ occupancy
        if (!within) continue;
        const limbFade = 1 - Math.pow(rad / r, 3); // fade near the edge
        g2.fillStyle = rgba("fg", (0.022 + rng() * 0.042 + (hovered ? 0.014 : 0)) * (0.35 + 0.65 * limbFade));
        g2.beginPath();
        g2.arc(Math.cos(ang) * rad, Math.sin(ang) * rad, 0.6 + rng() * 0.8, 0, TAU);
        g2.fill();
      }
    },
  );
  const rot = s.motionEnabled ? TAU * drift(s.t, 620, seed % 7) : 0;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rot);
  ctx.drawImage(disc, -r, -r, side, side);
  ctx.restore();

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
  // phase-driven by time; still (but present) in reduced-motion. `io` is
  // live-gated upstream; unknown or stale I/O never stirs the surface.
  if (io > 0.02) {
    const ioToken: ColorTokenName = writeDominant ? "flow-in" : "flow-out";
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

  // Organizing sweep: while an Arr reports an import into this pool, a
  // patient arc sweeps the atmosphere — local filesystem work being done ON
  // the body (a hardlink/rename is not a transfer, spec: local activity).
  const organizing = s.flows.some(
    (f) =>
      f.live.obs.kind === "organize" &&
      f.live.obs.freshness === "live" &&
      endpointIsPool(f, pool.name),
  );
  if (organizing) {
    const sweepPhase = s.motionEnabled ? drift(s.t, 11) : 0.3;
    const a0 = sweepPhase * TAU;
    ctx.strokeStyle = rgba("flow-ctl", 0.5);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(center.x, center.y, g.atmosphereR - 2, a0, a0 + TAU * 0.16);
    ctx.stroke();
    ctx.strokeStyle = rgba("flow-ctl", 0.18);
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.arc(center.x, center.y, g.atmosphereR - 2, a0, a0 + TAU * 0.16);
    ctx.stroke();
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

function endpointIsPool(f: LiveFlowGeom, name: string): boolean {
  const to = f.live.obs.to;
  return to.kind === "pool" && to.name === name;
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
  if (s.status === "down") return { token: "danger", alpha: 0.95, width: 1.6 };
  if (s.status === "degraded") return { token: "warn", alpha: 0.9, width: 1.4 };
  if (s.status === "not-configured") return { token: "hairline", alpha: 0.9, width: 1 };
  if (s.status === "neutral") return { token: "border", alpha: 0.75, width: 1 };
  return {
    token: glow > 0.04 ? "accent" : "border",
    alpha: 0.78 + glow * 0.22 + (hovered ? 0.12 : 0),
    width: 1.2 + glow * 0.6,
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
  const transcoding = svc.detail === "transcoding";

  // A whisper of interior so every body has mass, not just an outline.
  const body = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r);
  body.addColorStop(0, rgba("fg", svc.status === "not-configured" ? 0.015 : 0.05));
  body.addColorStop(0.75, rgba("fg", 0.014));
  body.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = body;
  ctx.fillRect(center.x - r, center.y - r, r * 2, r * 2);

  // Active service: a soft interior light rises with real work. A transcode
  // burns hotter (more excitation, same palette — no new colors).
  if (glow > 0.02 && svc.status === "ok") {
    const boost = transcoding ? 1.5 : 1;
    const pulse = transcoding && s.motionEnabled ? 0.85 + 0.15 * breathe(s.t, 6) : 1;
    const gl = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, r + 12);
    gl.addColorStop(0, rgba("accent", 0.12 * glow * boost * pulse));
    gl.addColorStop(0.7, rgba("accent", 0.06 * glow * boost * pulse));
    gl.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gl;
    ctx.fillRect(center.x - r - 12, center.y - r - 12, (r + 12) * 2, (r + 12) * 2);
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
    // Playback: a lens — inner rings plus a focal point. When streaming, the
    // lens visibly concentrates light along the playback path.
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.62, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.2);
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.36, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(svc.active ? "flow-out" : "fg", svc.active ? 0.85 : 0.32);
    ctx.beginPath();
    ctx.arc(center.x, center.y, svc.active ? 2.6 : 2.1, 0, TAU);
    ctx.fill();
  } else if (svc.id === "sonarr" || svc.id === "radarr") {
    // Siblings: three tiny satellites, phase-shifted so they are not twins.
    // While importing/organizing they tighten and brighten — controllers at
    // work, not data carriers.
    const organizing = svc.detail === "importing";
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r * 0.58, 0, TAU);
    ctx.stroke();
    const phase = svc.id === "sonarr" ? 0 : Math.PI / 3;
    const orbitR = r * (organizing ? 0.44 : 0.58);
    const speed = organizing ? 1.6 : 0.5;
    for (let i = 0; i < 3; i++) {
      const a = rot * speed + phase + (i / 3) * TAU;
      const p = pointOnCircle(center, orbitR, a);
      ctx.fillStyle = rgba(organizing ? "flow-ctl" : "fg", 0.46 + glow * 0.34);
      ctx.beginPath();
      ctx.arc(p.x, p.y, organizing ? 2 : 1.7, 0, TAU);
      ctx.fill();
    }
  } else if (svc.id === "qbittorrent") {
    // Downloader: denser, utilitarian — a fine inner segment ring that
    // spins with real transfer work.
    ctx.strokeStyle = rgba(stroke.token, stroke.alpha * 0.5);
    ctx.lineWidth = 1;
    const segs = 8;
    const spin = rot * (0.35 + glow * 0.5);
    for (let i = 0; i < segs; i++) {
      const a = spin + (i / segs) * TAU;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r * 0.6, a, a + (TAU / segs) * 0.55);
      ctx.stroke();
    }
    if (glow > 0.04) {
      ctx.fillStyle = rgba("flow-in", 0.5 * glow);
      ctx.beginPath();
      ctx.arc(center.x, center.y, 2, 0, TAU);
      ctx.fill();
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

function drawCore(ctx: CanvasRenderingContext2D, s: RenderState, pixelScale: number): void {
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
    field.addColorStop(0, rgba("accent", (0.05 + 0.17 * load) * alphaScale));
    field.addColorStop(0.6, rgba("accent", (0.02 + 0.09 * load) * alphaScale));
    field.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = field;
    ctx.fillRect(center.x - fieldR, center.y - fieldR, fieldR * 2, fieldR * 2);
  }

  // 2. Memory halo: a particulate dust torus — grains ALL the way around so
  // it always reads as one ring; the occupied fraction (from 12 o'clock)
  // carries denser, brighter grains with a soft taper at its edge, plus a
  // hairline measurement arc so the value is readable up close. Pre-rendered
  // (re-rendered only when occupancy moves ≥1%) and blitted.
  const memFraction = m.memFraction;
  const memQ = memFraction === null ? -1 : Math.round(memFraction * 100);
  const haloHalf = core.memR + core.memBandW + 6;
  const halo2 = layer(
    s.cache,
    "memHalo",
    `${memQ}:${alphaScale}:${pixelScale.toFixed(2)}`,
    haloHalf * 2 * pixelScale,
    haloHalf * 2 * pixelScale,
    (g) => {
      g.setTransform(pixelScale, 0, 0, pixelScale, haloHalf * pixelScale, haloHalf * pixelScale);
      const rng = makeRng(0x3e30a11);
      const grains = 480;
      for (let i = 0; i < grains; i++) {
        const baseA = (i / grains) * TAU + rng() * 0.02;
        const a = baseA - Math.PI / 2;
        const rr = core.memR + (rng() - 0.5) * core.memBandW;
        const posFrac = i / grains; // 0 at 12 o'clock, clockwise
        // 0..1 how "occupied" this angular position is, tapering over ~4% of
        // the circle at the boundary so the ring never has a hard cliff.
        const occ =
          memQ < 0 ? 0 : Math.max(0, Math.min(1, (memQ / 100 - posFrac) / 0.04 + 1));
        if (occ <= 0 && rng() > 0.8) continue; // the torus stays whole when free
        const alpha = (0.03 + rng() * 0.045 + occ * (0.1 + rng() * 0.1)) * alphaScale;
        g.fillStyle = rgba("fg", alpha);
        g.beginPath();
        g.arc(
          Math.cos(a) * rr,
          Math.sin(a) * rr,
          0.6 + rng() * 0.5 + occ * 0.55,
          0,
          TAU,
        );
        g.fill();
      }
    },
  );
  ctx.drawImage(halo2, center.x - haloHalf, center.y - haloHalf, haloHalf * 2, haloHalf * 2);
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
  const coronaRot = s.motionEnabled && !stale ? TAU * drift(s.t, 340) : 0;
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
      ctx.lineWidth = 2.8;
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

  // 3b. GPU work: a warm-white inner measurement arc, present only when GPU
  // utilization is actually measured (hardware transcode, compute) — local
  // reaction, no invented RAM/GPU flow paths.
  if (s.model.core.gpuFraction !== null && m.gpuLoad > 0.02) {
    const gpuR = core.spokeBaseR - 14;
    ctx.strokeStyle = rgba("fg", 0.3 * alphaScale);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(center.x, center.y, gpuR, -Math.PI / 2, -Math.PI / 2 + m.gpuLoad * TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba("hairline", 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center.x, center.y, gpuR, 0, TAU);
    ctx.stroke();
  }

  // 4. Inner core: a compact luminous disc, breathing very slowly with load.
  if (cpuKnown) {
    const breathing = s.motionEnabled && !stale ? 1 + 0.025 * (breathe(s.t, 41) - 0.5) * 2 : 1;
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
  // Lane + orbit + belt + gateway.
  circle(L.core.center.x, L.core.center.y, L.laneR, "rgba(0,255,255,0.35)");
  circle(L.core.center.x, L.core.center.y, L.serviceOrbitR, "rgba(0,255,128,0.35)");
  circle(L.core.center.x, L.core.center.y, L.core.boundaryR, "rgba(255,64,64,0.5)");
  circle(L.gateway.point.x, L.gateway.point.y, 8, "rgba(0,255,255,0.8)");
  // Bodies: hard radius + atmosphere + center.
  const bodies: BodyGeom[] = [...L.services.values(), ...L.storage.values()];
  if (L.genericStorage) bodies.push(L.genericStorage);
  for (const b of bodies) {
    circle(b.center.x, b.center.y, b.r, "rgba(255,255,0,0.6)");
    circle(b.center.x, b.center.y, b.atmosphereR, "rgba(255,255,0,0.25)");
    ctx.fillStyle = "rgba(255,255,0,0.8)";
    ctx.fillRect(b.center.x - 1.5, b.center.y - 1.5, 3, 3);
  }
  // Flow ports + samples (live solid, dormant dashed).
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(128,128,128,0.6)";
  for (const geom of s.dormant) strokeSampled(ctx, geom);
  ctx.setLineDash([]);
  for (const { geom } of s.flows) {
    ctx.fillStyle = "rgba(255,0,0,0.9)";
    for (const port of [geom.ports.from, geom.ports.to]) {
      ctx.beginPath();
      ctx.arc(port.x, port.y, 2.4, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(255,128,0,0.5)";
    strokeSampled(ctx, geom);
  }
  // Label boxes.
  ctx.strokeStyle = "rgba(128,128,255,0.6)";
  for (const b of labelsBoxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
}

// --- top-level ----------------------------------------------------------------

export function renderScene(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  s: RenderState,
  style: FlowStyle = PRODUCTION_FLOW_STYLE,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cam.w, cam.h);
  ctx.lineCap = "round";

  drawBackground(ctx, cam, s); // manages its own transforms (blits + vignette)
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.ox, cam.oy);
  drawGuides(ctx, s);
  drawNetworkArc(ctx, s);
  drawDormantRoutes(ctx, s);
  drawFlows(ctx, s, style);
  drawDockerBelt(ctx, s);
  for (const pool of s.model.storage) {
    const g = s.layout.storage.get(pool.name);
    if (g) drawStorageBody(ctx, s, pool, g, cam.scale);
  }
  drawGenericStorage(ctx, s);
  for (const svc of s.model.services) {
    const g = s.layout.services.get(svc.id);
    if (g) drawServiceBody(ctx, s, svc, g);
  }
  drawCore(ctx, s, cam.scale);
}
