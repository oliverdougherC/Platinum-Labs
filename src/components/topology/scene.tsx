"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildBackground } from "@/lib/scene/background";
import { buildLabels, LABEL_PRIMARY_PX, LABEL_SECONDARY_PX } from "@/lib/scene/labels";
import { computeLayout } from "@/lib/scene/layout";
import { buildSceneModel, type SceneModel, type ServiceId } from "@/lib/scene/model";
import { SceneMotion } from "@/lib/scene/motion";
import { drawDebug, renderScene, type Camera, type LiveFlowGeom } from "@/lib/scene/render";
import { routeFlow, type FlowGeom } from "@/lib/scene/routing";
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
 * and ~12 fps idle, fully stopped when the document is hidden, frozen and
 * reduced-motion render single static frames. Telemetry updates change TARGET
 * state (SceneMotion) — never rebuild the scene, never re-render React at
 * frame rate.
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
const IDLE_FRAME_MS = 1000 / 12;

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
  const geomCache = useRef<Map<string, FlowGeom | null>>(new Map());
  const stateRef = useRef({ model, layout, hovered, debug });

  useEffect(() => {
    stateRef.current = { model, layout, hovered, debug };
    motionRef.current!.applyModel(model);
    geomCacheForLayout(geomCache.current, layout);
  }, [model, layout, hovered, debug]);

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
      const { model: m, layout: l, hovered: hov, debug: dbg } = stateRef.current;
      const motion = motionRef.current!;
      const nowMs = frozen ? snapshot.generatedAt : Date.now();
      if (motionEnabled) motion.advance(nowMs);
      else motion.snapToTargets(nowMs);

      const cache = geomCache.current;
      const flows: LiveFlowGeom[] = [];
      for (const lf of motion.liveFlows()) {
        let geom = cache.get(lf.flow.id);
        if (geom === undefined) {
          geom = routeFlow(l, lf.flow);
          cache.set(lf.flow.id, geom);
        }
        if (geom) flows.push({ geom, intensity: lf.intensity });
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
        motion,
        background,
        hovered: hov,
        t: motionEnabled ? tSeconds : 120, // fixed, non-zero ambient phase
        motionEnabled,
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

  return (
    <div ref={hostRef} className="relative h-full w-full select-none overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
      {/* Typography overlay: real text, projected from world coordinates. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        {labels.map((lb) => {
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
        {bodies.map((b) => {
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
      </div>
    </div>
  );
}
