"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildBackground } from "@/lib/scene/background";
import {
  buildLabels,
  describeFlow,
  LABEL_PRIMARY_PX,
  LABEL_SECONDARY_PX,
} from "@/lib/scene/labels";
import { computeLayout } from "@/lib/scene/layout";
import { buildSceneModel, type SceneModel, type ServiceId } from "@/lib/scene/model";
import { SceneMotion } from "@/lib/scene/motion";
import {
  drawDebug,
  makeRenderCache,
  renderScene,
  type Camera,
  type LiveFlowGeom,
  type RenderCache,
} from "@/lib/scene/render";
import { dormantRoutes, routeFlow, type FlowGeom } from "@/lib/scene/routing";
import { pointAtLength } from "@/lib/scene/geom";
import type { SceneLayout } from "@/lib/scene/layout";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * The Living Topology scene host (PLA-266 rebuild): a Canvas-2D real-time
 * renderer with a DOM overlay for typography and interaction.
 *
 * RENDERER CHOICE — Canvas 2D, deliberately:
 *  - the scene is a few hundred primitives; a 2D context renders it in well
 *    under a millisecond and costs no GPU memory management, no WebGL context
 *    loss handling, and no new dependency for a page that runs 24/7;
 *  - text stays in the DOM (crisp at every devicePixelRatio, real
 *    accessibility tree), projected from world coordinates;
 *  - rendering is deterministic (fixed seed, time-parameterized motion), which
 *    the screenshot review pipeline depends on.
 *
 * Loop engineering (spec §23): one rAF loop, frame-skipped to ~30 fps active
 * and ~10 fps idle, fully stopped when the document is hidden, frozen and
 * reduced-motion render single static frames. Telemetry updates change TARGET
 * state (SceneMotion) — never rebuild the scene, never re-render React at
 * frame rate.
 *
 * FLOW INSPECTION (PLA-266 v2): live flows are hoverable (nearest-path hit
 * test on the canvas) and keyboard-focusable (a small focus target at each
 * flow's midpoint). Both surface a provenance tooltip: semantic label,
 * evidence class, exact directional rates, freshness.
 */

export type TopologySelection =
  | { kind: "host" }
  | { kind: "pool"; name: string }
  | { kind: "service"; id: ServiceId }
  | { kind: "docker" };

export interface SceneProps {
  snapshot: DashboardSnapshot;
  /** Reference time for staleness gating (snapshot time when frozen). */
  now: number;
  seerrConfigured: boolean;
  frozen: boolean;
  reducedMotion: boolean;
  /** Dev-only geometry overlay (never available in production builds). */
  debug?: boolean;
  onSelect: (sel: TopologySelection) => void;
}

const ACTIVE_FRAME_MS = 1000 / 30;
const IDLE_FRAME_MS = 1000 / 10;

/** World-space distance within which a pointer "touches" a flow path. */
const FLOW_HIT_DISTANCE = 14;

interface HitBody {
  id: string;
  label: string;
  cx: number;
  cy: number;
  r: number;
  selection: TopologySelection;
}

function hitBodies(model: SceneModel, layout: SceneLayout): HitBody[] {
  const out: HitBody[] = [];
  out.push({
    id: "core",
    label: "Host compute detail",
    cx: layout.core.center.x,
    cy: layout.core.center.y,
    r: layout.core.memR + layout.core.memBandW,
    selection: { kind: "host" },
  });
  for (const s of model.services) {
    const g = layout.services.get(s.id);
    if (!g) continue;
    out.push({
      id: g.id,
      label: `${s.label} detail`,
      cx: g.center.x,
      cy: g.center.y,
      r: g.r + 12,
      selection: { kind: "service", id: s.id },
    });
  }
  for (const pool of model.storage) {
    const g = layout.storage.get(pool.name);
    if (!g) continue;
    out.push({
      id: g.id,
      label: `${pool.name} storage detail`,
      cx: g.center.x,
      cy: g.center.y,
      r: g.atmosphereR,
      selection: { kind: "pool", name: pool.name },
    });
  }
  if (model.docker.status !== "not-configured") {
    const belt = layout.dockerBelt;
    const mid = (belt.a0 + belt.a1) / 2;
    out.push({
      id: "docker",
      label: "Docker containers detail",
      cx: belt.center.x + Math.cos(mid) * belt.r,
      cy: belt.center.y + Math.sin(mid) * belt.r,
      r: 54,
      selection: { kind: "docker" },
    });
  }
  return out;
}

const LABEL_TONE_CLASS: Record<string, string> = {
  fg: "text-fg",
  muted: "text-muted",
  faint: "text-faint",
  warn: "text-warn",
  danger: "text-danger",
};

export function TopologyScene({
  snapshot,
  now,
  seerrConfigured,
  frozen,
  reducedMotion,
  debug = false,
  onSelect,
}: SceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  /** Hovered/focused flow tooltip: flow id + world anchor. */
  const [flowTip, setFlowTip] = useState<{ id: string; x: number; y: number } | null>(null);
  // Overlays render only after mount: the server has no viewport, so SSR'ing
  // projected positions would paint garbage and mismatch on hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const motionEnabled = !frozen && !reducedMotion;

  const model = useMemo(
    () => buildSceneModel(snapshot, { seerrConfigured, now }),
    [snapshot, seerrConfigured, now],
  );

  const aspect = size.h > 0 ? size.w / size.h : 16 / 9;
  const layout = useMemo(() => computeLayout(model, aspect), [model, aspect]);
  const background = useMemo(() => buildBackground(), []);
  const labels = useMemo(() => buildLabels(model, layout, now), [model, layout, now]);
  const bodies = useMemo(() => hitBodies(model, layout), [model, layout]);
  const dormant = useMemo(() => dormantRoutes(layout, model), [layout, model]);

  const camera: Camera = useMemo(() => {
    const scale = size.h > 0 ? Math.min(size.w / layout.world.w, size.h / layout.world.h) : 1;
    return {
      w: size.w,
      h: size.h,
      scale,
      ox: (size.w - layout.world.w * scale) / 2,
      oy: (size.h - layout.world.h * scale) / 2,
    };
  }, [size, layout]);

  // Long-lived render state, mutated outside React.
  const motionRef = useRef<SceneMotion | null>(null);
  if (motionRef.current === null) motionRef.current = new SceneMotion();
  const renderCacheRef = useRef<RenderCache | null>(null);
  if (renderCacheRef.current === null) renderCacheRef.current = makeRenderCache();
  const geomCache = useRef<Map<string, FlowGeom | null>>(new Map());
  const stateRef = useRef({ model, layout, hovered: null as string | null, debug, dormant });

  const hoveredEffective = flowTip?.id ?? hovered;
  useEffect(() => {
    stateRef.current = { model, layout, hovered: hoveredEffective, debug, dormant };
    motionRef.current!.applyModel(model);
    geomCacheForLayout(geomCache.current, layout);
  }, [model, layout, hoveredEffective, debug, dormant]);

  // Routing cache: layout identity changes invalidate all geoms.
  const layoutIdRef = useRef<SceneLayout | null>(null);
  function geomCacheForLayout(cache: Map<string, FlowGeom | null>, l: SceneLayout) {
    if (layoutIdRef.current !== l) {
      cache.clear();
      layoutIdRef.current = l;
    }
  }

  // Size tracking.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const apply = () => {
      const rect = host.getBoundingClientRect();
      setSize((prev) =>
        prev.w === Math.round(rect.width) && prev.h === Math.round(rect.height)
          ? prev
          : { w: Math.round(rect.width), h: Math.round(rect.height) },
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const drawFrame = useCallback(
    (tSeconds: number) => {
      const canvas = canvasRef.current;
      if (!canvas || size.w === 0 || size.h === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(size.w * dpr) || canvas.height !== Math.round(size.h * dpr)) {
        canvas.width = Math.round(size.w * dpr);
        canvas.height = Math.round(size.h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { model: m, layout: l, hovered: hov, debug: dbg, dormant: dorm } = stateRef.current;
      const motion = motionRef.current!;
      const nowMs = frozen ? snapshot.generatedAt : Date.now();
      if (motionEnabled) motion.advance(nowMs);
      else motion.snapToTargets(nowMs);

      const cache = geomCache.current;
      const flows: LiveFlowGeom[] = [];
      for (const lf of motion.liveFlows()) {
        let geom = cache.get(lf.obs.id);
        if (geom === undefined) {
          geom = routeFlow(l, lf.obs);
          cache.set(lf.obs.id, geom);
        }
        if (geom) flows.push({ geom: { ...geom, flow: lf.obs }, live: lf });
      }

      const cam: Camera = {
        w: size.w * dpr,
        h: size.h * dpr,
        scale: camera.scale * dpr,
        ox: camera.ox * dpr,
        oy: camera.oy * dpr,
      };
      const state = {
        model: m,
        layout: l,
        flows,
        dormant: dorm,
        motion,
        background,
        hovered: hov,
        t: motionEnabled ? tSeconds : 120, // fixed, non-zero ambient phase
        motionEnabled,
        cache: renderCacheRef.current!,
      };
      renderScene(ctx, cam, state);
      if (dbg && process.env.NODE_ENV !== "production") {
        drawDebug(
          ctx,
          state,
          buildLabels(m, l, now).map((lb) => ({
            x: lb.anchor.x - lb.box.w / 2,
            y: lb.anchor.y,
            w: lb.box.w,
            h: lb.box.h,
          })),
        );
      }
    },
    [size, camera, background, frozen, motionEnabled, snapshot.generatedAt, now],
  );

  // The render loop.
  useEffect(() => {
    if (!motionEnabled) {
      // Static mode: exactly one frame per data/size change.
      drawFrame(120);
      return;
    }
    let raf = 0;
    let last = 0;
    const t0 = performance.now();
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      const hasFlows = motionRef.current!.liveFlows().length > 0;
      const budget = hasFlows ? ACTIVE_FRAME_MS : IDLE_FRAME_MS;
      if (ts - last < budget) return;
      last = ts;
      drawFrame((ts - t0) / 1000);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [motionEnabled, drawFrame]);

  const project = useCallback(
    (x: number, y: number) => ({
      x: camera.ox + x * camera.scale,
      y: camera.oy + y * camera.scale,
    }),
    [camera],
  );

  // Live-flow geometry for interaction (hit test + focus targets): derived
  // from the MODEL (current truth), not the easing motion state.
  const flowGeoms = useMemo(() => {
    const out: FlowGeom[] = [];
    for (const obs of model.flows) {
      const g = routeFlow(layout, obs);
      if (g) out.push(g);
    }
    return out;
  }, [model, layout]);

  const findFlowAt = useCallback(
    (screenX: number, screenY: number): { id: string; x: number; y: number } | null => {
      if (camera.scale <= 0) return null;
      const wx = (screenX - camera.ox) / camera.scale;
      const wy = (screenY - camera.oy) / camera.scale;
      let best: { id: string; x: number; y: number; d: number } | null = null;
      for (const g of flowGeoms) {
        for (const p of g.path.points) {
          const d = Math.hypot(p.x - wx, p.y - wy);
          if (d < FLOW_HIT_DISTANCE && (!best || d < best.d)) {
            best = { id: g.flow.id, x: wx, y: wy, d };
          }
        }
      }
      return best ? { id: best.id, x: best.x, y: best.y } : null;
    },
    [camera, flowGeoms],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Body hover (buttons) takes precedence; only probe flows on the ground.
      if ((e.target as HTMLElement).tagName === "BUTTON") {
        setFlowTip((cur) => (cur ? null : cur));
        return;
      }
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect) return;
      const hit = findFlowAt(e.clientX - rect.left, e.clientY - rect.top);
      setFlowTip((cur) =>
        hit === null
          ? cur === null
            ? cur
            : null
          : cur && cur.id === hit.id && Math.abs(cur.x - hit.x) < 4 && Math.abs(cur.y - hit.y) < 4
            ? cur
            : hit,
      );
    },
    [findFlowAt],
  );

  const tipFlow = flowTip
    ? model.flows.find((f) => f.id === flowTip.id) ?? null
    : null;
  const tipText = tipFlow ? describeFlow(tipFlow, now) : null;

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full select-none overflow-hidden"
      onPointerMove={onPointerMove}
      onPointerLeave={() => setFlowTip(null)}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
      {/* Typography overlay: real text, projected from world coordinates. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {mounted && labels.map((lb) => {
          const p = project(lb.anchor.x, lb.anchor.y);
          return (
            <div
              key={lb.id}
              className="absolute -translate-x-1/2 text-center leading-tight"
              style={{ left: p.x, top: p.y }}
            >
              <div
                className={LABEL_TONE_CLASS[lb.primaryTone]}
                style={{ fontSize: LABEL_PRIMARY_PX * camera.scale }}
              >
                {lb.primary}
              </div>
              {lb.secondary && (
                <div
                  className={`tnum ${LABEL_TONE_CLASS[lb.secondaryTone]}`}
                  style={{ fontSize: LABEL_SECONDARY_PX * camera.scale }}
                >
                  {lb.secondary}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* Interaction overlay: semantic, keyboard-reachable hit areas. */}
      <div className="absolute inset-0" role="group" aria-label="Live homelab topology">
        {mounted && bodies.map((b) => {
          const p = project(b.cx, b.cy);
          const rPx = b.r * camera.scale;
          return (
            <button
              key={b.id}
              type="button"
              aria-label={b.label}
              onClick={() => onSelect(b.selection)}
              onMouseEnter={() => setHovered(b.id)}
              onMouseLeave={() => setHovered((h) => (h === b.id ? null : h))}
              onFocus={() => setHovered(b.id)}
              onBlur={() => setHovered((h) => (h === b.id ? null : h))}
              className="absolute cursor-pointer rounded-full outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              style={{
                left: p.x - rPx,
                top: p.y - rPx,
                width: rPx * 2,
                height: rPx * 2,
              }}
            />
          );
        })}
        {/* Flow focus targets: keyboard access to each live flow's provenance. */}
        {mounted && flowGeoms.map((g) => {
          const mid = pointAtLength(g.path, g.path.totalLength / 2);
          const p = project(mid.x, mid.y);
          const d = describeFlow(g.flow, now);
          return (
            <button
              key={g.flow.id}
              type="button"
              aria-label={`${d.summary}. ${d.detail}`}
              onFocus={() => setFlowTip({ id: g.flow.id, x: mid.x, y: mid.y })}
              onBlur={() => setFlowTip((cur) => (cur?.id === g.flow.id ? null : cur))}
              className="absolute rounded-full outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              style={{ left: p.x - 9, top: p.y - 9, width: 18, height: 18 }}
            />
          );
        })}
      </div>
      {/* Flow provenance tooltip (hover/focus) — restrained, single instance. */}
      {mounted && flowTip && tipText && (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-hairline bg-surface/95 px-3 py-2 shadow-lg"
          style={{
            left: Math.min(project(flowTip.x, flowTip.y).x + 14, size.w - 280),
            top: project(flowTip.x, flowTip.y).y + 14,
          }}
          role="status"
        >
          <div className="tnum text-[12px] leading-snug text-fg">{tipText.summary}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-faint">{tipText.detail}</div>
        </div>
      )}
    </div>
  );
}
