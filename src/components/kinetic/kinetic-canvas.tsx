"use client";

/**
 * V4 Kinetic Flow Canvas — the stage component.
 *
 * Hybrid rendering: one Canvas 2D layer for light (glow pools, ribbons,
 * particles, workload field, storage strata) and a DOM overlay for every
 * piece of text and every interactive/accessible target. React stays out of
 * the frame loop: the painter redraws imperatively from refs, and the rAF
 * loop runs only while something is actually moving (parked when quiet,
 * frozen, reduced-motion, or the tab is hidden).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { formatRate } from "@/lib/format/bytes";
import {
  buildKineticScene,
  type AnchorModel,
  type KineticFlow,
  type KineticScene,
} from "@/lib/kinetic/model";
import { buildKineticLayout, type KineticLayout } from "@/lib/kinetic/layout";
import {
  drawKineticFrame,
  sceneAnimates,
  type FlowEnvelope,
  type KineticSelection,
} from "@/lib/kinetic/render";

const ONSET_MS = 900;
const DECAY_MS = 700;

export interface KineticCanvasProps {
  snapshot: DashboardSnapshot;
  now: number;
  seerrConfigured: boolean;
  /** Frozen surfaces draw exactly one deterministic frame (no rAF). */
  frozen: boolean;
  surfaceLabel?: string;
}

interface FadingFlow {
  flow: KineticFlow;
  removedAt: number;
}

function useStageSize(ref: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    });
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const apply = () => setVisible(!document.hidden);
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);
  return visible;
}

// --- inspector content -----------------------------------------------------------------

interface InspectorContent {
  title: string;
  status: string | null;
  metrics: Array<{ label: string; value: string }>;
  relationships: string[];
  x: number;
  y: number;
}

const FLOW_KIND_WORDS: Record<KineticFlow["kind"], string> = {
  "wan-transfer": "WAN transfer",
  "storage-transfer": "staging I/O",
  "import-copy": "import copy",
  playback: "library read",
  egress: "stream egress",
  organize: "import organizing",
  control: "orchestration",
};

function flowLine(flow: KineticFlow): string {
  const rate = flow.rateBps !== null ? ` · ${formatRate(flow.rateBps)}` : "";
  const state =
    flow.treatment === "stale"
      ? " · stale"
      : flow.treatment === "confirmed-zero"
        ? " · 0 B/s"
        : flow.treatment === "state-only"
          ? " · rate unknown"
          : "";
  return `${FLOW_KIND_WORDS[flow.kind]} — ${flow.label}${rate}${state}`;
}

function compactFlowLine(flow: KineticFlow): string {
  const rate =
    flow.rateBps !== null
      ? formatRate(flow.rateBps)
      : flow.treatment === "stale"
        ? "stale"
        : flow.treatment === "confirmed-zero"
          ? "0 B/s"
          : "rate unknown";
  return `${FLOW_KIND_WORDS[flow.kind]} · ${rate}`;
}

function inspectorFor(
  selection: KineticSelection,
  scene: KineticScene,
  layout: KineticLayout,
): InspectorContent | null {
  const flowsTouching = (match: (f: KineticFlow) => boolean) =>
    scene.flows.filter(match).slice(0, 5).map(compactFlowLine);

  if (selection.kind === "anchor") {
    const anchor = scene.anchors.find((a) => a.id === selection.id);
    const placed = layout.anchors.find((a) => a.id === selection.id);
    if (!anchor || !placed) return null;
    const metrics: InspectorContent["metrics"] = [];
    if (anchor.rateLine) metrics.push({ label: "throughput", value: anchor.rateLine });
    if (anchor.cpuCores !== null)
      metrics.push({ label: "cpu", value: `${anchor.cpuCores.toFixed(2)}c` });
    if (anchor.memoryBytes !== null)
      metrics.push({ label: "memory", value: formatBytesShort(anchor.memoryBytes) });
    return {
      title: anchor.label,
      status: anchor.headline ?? statusWord(anchor),
      metrics: metrics.slice(0, 3),
      relationships: flowsTouching(
        (f) =>
          (f.from.kind === "anchor" && f.from.id === selection.id) ||
          (f.to.kind === "anchor" && f.to.id === selection.id),
      ),
      x: placed.x,
      y: placed.y,
    };
  }
  if (selection.kind === "pool") {
    const pool = scene.storage.find((s) => s.name === selection.id);
    const placed = layout.strata.find((s) => s.name === selection.id);
    if (!pool || !placed) return null;
    const metrics: InspectorContent["metrics"] = [
      {
        label: pool.capacityBasis === "logical" ? "used" : "allocated",
        value: `${pool.usedLabel} of ${pool.totalLabel}`,
      },
    ];
    if (pool.ioFreshness === "live" && pool.readBps !== null)
      metrics.push({ label: "read", value: formatRate(pool.readBps) });
    if (pool.ioFreshness === "live" && pool.writeBps !== null)
      metrics.push({ label: "write", value: formatRate(pool.writeBps) });
    return {
      title: pool.name,
      status: pool.healthy ? (pool.scrubbing ? "scrubbing" : null) : pool.healthLabel,
      metrics: metrics.slice(0, 3),
      relationships: flowsTouching(
        (f) =>
          (f.from.kind === "pool" && f.from.name === selection.id) ||
          (f.to.kind === "pool" && f.to.name === selection.id),
      ),
      x: placed.x + placed.w / 2,
      y: placed.y,
    };
  }
  if (selection.kind === "cell") {
    for (const group of scene.field) {
      const cell = group.cells.find((c) => c.id === selection.id);
      if (!cell) continue;
      const placedGroup = layout.groups.find((g) => g.id === group.id);
      const placed = placedGroup?.cells.find((c) => c.id === selection.id);
      if (!placed) return null;
      const metrics: InspectorContent["metrics"] = [];
      if (cell.cpuFraction !== null)
        metrics.push({ label: "cpu", value: `${cell.cpuFraction.toFixed(2)}c` });
      if (cell.memoryBytes !== null)
        metrics.push({ label: "memory", value: formatBytesShort(cell.memoryBytes) });
      return {
        title: cell.name,
        status: cell.attention
          ? "needs attention"
          : cell.unverified
            ? "state unknown"
            : cell.running
              ? null
              : "not running",
        metrics: metrics.slice(0, 3),
        relationships: [group.label],
        x: placed.x,
        y: placed.y,
      };
    }
  }
  return null;
}

function statusWord(anchor: AnchorModel): string | null {
  if (anchor.status === "down") return "unavailable";
  if (anchor.status === "degraded") return "degraded";
  if (anchor.status === "not-configured") return "not configured";
  return anchor.active ? null : "idle";
}

function formatBytesShort(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

// --- component ---------------------------------------------------------------------------

export function KineticCanvas({
  snapshot,
  now,
  seerrConfigured,
  frozen,
  surfaceLabel = "Kinetic flow canvas",
}: KineticCanvasProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { w, h } = useStageSize(stageRef);
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const [selection, setSelection] = useState<KineticSelection | null>(null);

  const scene = useMemo(
    () => buildKineticScene(snapshot, { now, seerrConfigured }),
    [snapshot, now, seerrConfigured],
  );

  // Graceful onset and decay: newly appearing flows ramp in over ONSET_MS;
  // flows that leave the truth model linger as fading ghosts for DECAY_MS
  // instead of popping out. Frozen and reduced-motion surfaces skip both.
  const seenRef = useRef<Map<string, number>>(new Map());
  const prevFlowsRef = useRef<KineticFlow[]>([]);
  const [ghosts, setGhosts] = useState<FadingFlow[]>([]);

  useEffect(() => {
    if (frozen || reducedMotion) {
      prevFlowsRef.current = scene.flows;
      return;
    }
    const stamp = performance.now();
    const ids = new Set(scene.flows.map((f) => f.id));
    for (const id of ids) {
      if (!seenRef.current.has(id)) seenRef.current.set(id, stamp);
    }
    for (const id of [...seenRef.current.keys()]) {
      if (!ids.has(id)) seenRef.current.delete(id);
    }
    const removed = prevFlowsRef.current.filter((f) => !ids.has(f.id));
    prevFlowsRef.current = scene.flows;
    if (removed.length > 0) {
      setGhosts((current) => [
        ...current.filter(
          (g) => !ids.has(g.flow.id) && !removed.some((r) => r.id === g.flow.id),
        ),
        ...removed.map((flow) => ({ flow, removedAt: stamp })),
      ]);
    } else {
      setGhosts((current) => (current.some((g) => ids.has(g.flow.id)) ? current.filter((g) => !ids.has(g.flow.id)) : current));
    }
  }, [scene, frozen, reducedMotion]);

  useEffect(() => {
    if (ghosts.length === 0) return;
    const timer = window.setTimeout(
      () => setGhosts((current) => current.filter((g) => performance.now() - g.removedAt < DECAY_MS)),
      DECAY_MS + 60,
    );
    return () => window.clearTimeout(timer);
  }, [ghosts]);

  const renderScene = useMemo(() => {
    if (ghosts.length === 0) return scene;
    const present = new Set(scene.flows.map((f) => f.id));
    const ghostFlows = ghosts.map((g) => g.flow).filter((f) => !present.has(f.id));
    return ghostFlows.length > 0 ? { ...scene, flows: [...scene.flows, ...ghostFlows] } : scene;
  }, [scene, ghosts]);

  const layout = useMemo(
    () => (w > 0 && h > 0 ? buildKineticLayout(renderScene, w, h) : null),
    [renderScene, w, h],
  );

  const ghostsRef = useRef(ghosts);
  const sceneRef = useRef(renderScene);
  const layoutRef = useRef(layout);
  const selectionRef = useRef(selection);
  ghostsRef.current = ghosts;
  sceneRef.current = renderScene;
  layoutRef.current = layout;
  selectionRef.current = selection;

  const draw = useCallback(
    (t: number, still: boolean, marks: boolean) => {
      const canvas = canvasRef.current;
      const currentLayout = layoutRef.current;
      if (!canvas || !currentLayout) return;
      const dpr = still ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      const pixelW = Math.round(currentLayout.w * dpr);
      const pixelH = Math.round(currentLayout.h * dpr);
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const envelopes = new Map<string, FlowEnvelope>();
      if (!still) {
        const stamp = performance.now();
        for (const flow of sceneRef.current.flows) {
          const born = seenRef.current.get(flow.id);
          if (born !== undefined) {
            const age = stamp - born;
            envelopes.set(flow.id, {
              alpha: Math.min(1, Math.max(0, age / ONSET_MS)),
            });
          }
        }
        for (const ghost of ghostsRef.current) {
          const age = stamp - ghost.removedAt;
          envelopes.set(ghost.flow.id, {
            alpha: Math.min(1, Math.max(0, 1 - age / DECAY_MS)),
          });
        }
      }
      drawKineticFrame(ctx, sceneRef.current, currentLayout, {
        t,
        selection: selectionRef.current,
        envelopes,
        still,
        marks,
      });
    },
    [],
  );

  // Deterministic frozen frame: t derived from the frozen clock, dpr = 1,
  // full envelopes, still particles rendered as direction marks only when
  // reduced motion asks for it — a frozen live scene keeps its particle field
  // placed at the frozen t so screenshots show real motion state.
  const animate =
    !frozen &&
    !reducedMotion &&
    pageVisible &&
    (sceneAnimates(renderScene) || ghosts.length > 0);

  useEffect(() => {
    if (!layout) return;
    if (animate) {
      let raf = 0;
      const start = performance.now();
      const tick = () => {
        draw((performance.now() - start) / 1000 + (now % 100_000) / 1000, false, false);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    // Parked: paint exactly one frame. A frozen scene keeps its particle
    // field placed at the frozen clock; reduced motion swaps particles for
    // static direction marks.
    draw((now % 100_000) / 1000, frozen || reducedMotion, reducedMotion);
    return undefined;
  }, [animate, draw, layout, frozen, reducedMotion, renderScene, selection, now]);

  // Escape clears selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectionRef.current) {
        event.preventDefault();
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const inspector = useMemo(
    () => (selection && layout ? inspectorFor(selection, scene, layout) : null),
    [selection, scene, layout],
  );

  const toggle = useCallback((next: KineticSelection) => {
    setSelection((prev) =>
      prev && prev.kind === next.kind && prev.id === next.id ? null : next,
    );
  }, []);

  const cellsById = useMemo(() => {
    const map = new Map<string, { name: string; label: string }>();
    for (const group of scene.field) {
      for (const cell of group.cells) map.set(cell.id, { name: cell.name, label: group.label });
    }
    return map;
  }, [scene]);

  return (
    <div
      ref={stageRef}
      data-kinetic-stage
      data-motion={animate ? "on" : "off"}
      className="relative h-full w-full overflow-hidden bg-[#07090d] text-fg select-none"
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === canvasRef.current) {
          setSelection(null);
        }
      }}
    >
      {/* Non-visual channel: every visible flow, stated plainly. */}
      <ul className="sr-only" aria-label="Active data flows">
        {scene.flows.map((flow) => (
          <li key={flow.id}>{flowLine(flow)}</li>
        ))}
      </ul>

      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />

      {layout ? (
        <KineticOverlay
          scene={scene}
          layout={layout}
          selection={selection}
          toggle={toggle}
          cellsById={cellsById}
          surfaceLabel={surfaceLabel}
        />
      ) : null}

      {inspector && layout ? (
        <aside
          data-kinetic-inspector
          aria-label={`${inspector.title} inspector`}
          className="absolute z-30 w-64 rounded-lg border border-white/[0.07] bg-[#0d1016]/95 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-sm"
          style={{
            left: Math.min(Math.max(inspector.x - 128, 12), layout.w - 268),
            top: Math.min(Math.max(inspector.y - 12, layout.bandH + 8), layout.h - 220),
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">
              {inspector.title}
            </h2>
            <button
              type="button"
              aria-label="Close inspector"
              className="text-faint transition-opacity hover:opacity-70"
              onClick={() => setSelection(null)}
            >
              ×
            </button>
          </div>
          {inspector.status ? (
            <p className="mt-0.5 text-[12px] text-muted">{inspector.status}</p>
          ) : null}
          {inspector.metrics.length > 0 ? (
            <dl className="mt-2.5 space-y-1">
              {inspector.metrics.map((m) => (
                <div key={m.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-faint">
                    {m.label}
                  </dt>
                  <dd className="text-[13px] tabular-nums text-fg">{m.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {inspector.relationships.length > 0 ? (
            <ul className="mt-2.5 space-y-1 border-t border-white/[0.06] pt-2.5">
              {inspector.relationships.map((line) => (
                <li key={line} className="text-[12px] leading-snug text-muted">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

// --- DOM overlay ----------------------------------------------------------------------------

function KineticOverlay({
  scene,
  layout,
  selection,
  toggle,
  cellsById,
  surfaceLabel,
}: {
  scene: KineticScene;
  layout: KineticLayout;
  selection: KineticSelection | null;
  toggle: (next: KineticSelection) => void;
  cellsById: Map<string, { name: string; label: string }>;
  surfaceLabel: string;
}) {
  const dimClass = (member: KineticSelection): string => {
    if (!selection) return "";
    if (selection.kind === member.kind && selection.id === member.id) return "";
    const related = scene.flows.some((flow) => {
      const touches = (sel: KineticSelection) =>
        [flow.from, flow.to].some((ref) => {
          if (sel.kind === "anchor") return ref.kind === "anchor" && ref.id === sel.id;
          if (sel.kind === "pool") return ref.kind === "pool" && ref.name === sel.id;
          if (sel.kind === "edge") return ref.kind === "edge" && ref.id === sel.id;
          if (sel.kind === "orchestrator")
            return ref.kind === "orchestrator" && ref.id === sel.id;
          return false;
        });
      return touches(selection) && touches(member);
    });
    return related ? "" : "opacity-25";
  };

  return (
    <div
      role="group"
      aria-label={surfaceLabel}
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      <InstrumentBand scene={scene} layout={layout} />

      {/* Orchestration row. */}
      {layout.orchestrators.map((placed) => {
        const model = scene.orchestration.find((o) => o.id === placed.id);
        if (!model || model.status === "not-configured") return null;
        return (
          <div
            key={placed.id}
            className={`absolute -translate-x-1/2 -translate-y-1/2 text-center transition-opacity duration-300 ${dimClass({ kind: "orchestrator", id: placed.id })}`}
            style={{ left: placed.x, top: placed.y }}
          >
            <div
              className={`text-[12px] font-medium uppercase tracking-[0.22em] ${
                model.active ? "text-muted" : "text-faint/70"
              }`}
            >
              {model.label}
            </div>
            {model.detail ? (
              <div className="mt-0.5 text-[11px] tracking-wide text-faint">{model.detail}</div>
            ) : null}
          </div>
        );
      })}

      {/* Anchors. */}
      {layout.anchors.map((placed) => {
        const model = scene.anchors.find((a) => a.id === placed.id);
        if (!model) return null;
        const idle = !model.active;
        return (
          <button
            key={placed.id}
            type="button"
            data-kinetic-anchor={placed.id}
            aria-label={`${model.label}${model.headline ? `; ${model.headline}` : idle ? "; idle" : ""}`}
            onClick={() => toggle({ kind: "anchor", id: placed.id })}
            className={`absolute -translate-x-1/2 -translate-y-1/2 text-center transition-opacity duration-300 ${dimClass({ kind: "anchor", id: placed.id })}`}
            style={{ left: placed.x, top: placed.y, pointerEvents: "auto" }}
          >
            <div
              className={`text-[30px] font-semibold tracking-tight ${
                idle ? "text-muted/70" : "text-fg"
              }`}
            >
              {model.label}
            </div>
            {model.headline ? (
              <div className="mt-1 text-[13px] tracking-wide text-muted">{model.headline}</div>
            ) : null}
            {model.rateLine ? (
              <div className="mt-0.5 text-[13px] tabular-nums tracking-wide text-fg/80">
                {model.rateLine}
              </div>
            ) : null}
            {model.status === "down" ? (
              <div className="mt-1 text-[12px] tracking-wide text-warn">unavailable</div>
            ) : null}
          </button>
        );
      })}

      {/* Network edge anchors. */}
      {layout.edges.map((placed) => {
        const model = scene.edges.find((e) => e.id === placed.id);
        if (!model) return null;
        return (
          <div
            key={placed.id}
            className={`absolute -translate-y-1/2 transition-opacity duration-300 ${
              placed.side === "left" ? "" : "text-right"
            } ${dimClass({ kind: "edge", id: placed.id })}`}
            style={{
              left: placed.side === "left" ? placed.x - 8 : undefined,
              right: placed.side === "right" ? layout.w - placed.x - 8 : undefined,
              top: placed.y,
            }}
          >
            {model.labels.map((label) => (
              <div
                key={label}
                className={`text-[11px] font-medium uppercase tracking-[0.24em] ${
                  model.active ? "text-muted" : "text-faint/60"
                }`}
              >
                {label}
              </div>
            ))}
          </div>
        );
      })}

      {/* Workload field: hit targets + selective labels + group captions. */}
      {layout.groups.map((group) => (
        <div key={group.id}>
          <div
            className="absolute -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.26em] text-faint/55"
            style={{ left: group.cx, top: group.labelY }}
          >
            {group.label}
          </div>
          {group.cells.map((placed) => {
            const info = cellsById.get(placed.id);
            const cell = scene.field
              .flatMap((g) => g.cells)
              .find((c) => c.id === placed.id);
            if (!info || !cell) return null;
            return (
              <button
                key={placed.id}
                type="button"
                aria-label={`${info.name}; ${info.label}${cell.attention ? "; needs attention" : ""}`}
                onClick={() => toggle({ kind: "cell", id: placed.id })}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: placed.x,
                  top: placed.y,
                  width: Math.max(placed.r * 2 + 8, 16),
                  height: Math.max(placed.r * 2 + 8, 16),
                  pointerEvents: "auto",
                }}
              >
                <span className="sr-only">{info.name}</span>
              </button>
            );
          })}
          {group.cells.map((placed) => {
            const cell = scene.field
              .flatMap((g) => g.cells)
              .find((c) => c.id === placed.id);
            if (!cell?.labelVisible) return null;
            return (
              <div
                key={`${placed.id}-label`}
                className={`absolute -translate-x-1/2 text-[10.5px] tracking-wide ${
                  cell.attention ? "text-warn" : "text-faint"
                }`}
                style={{ left: placed.x, top: placed.y + placed.r + 5 }}
              >
                {cell.name}
              </div>
            );
          })}
        </div>
      ))}

      {/* Storage labels. */}
      {layout.strata.map((placed) => {
        const pool = scene.storage.find((s) => s.name === placed.name);
        if (!pool) return null;
        return (
          <button
            key={placed.name}
            type="button"
            data-kinetic-pool={placed.name}
            aria-label={`${pool.name}; ${pool.usedLabel} of ${pool.totalLabel} used${pool.healthy ? "" : `; ${pool.healthLabel}`}`}
            onClick={() => toggle({ kind: "pool", id: placed.name })}
            className={`absolute whitespace-nowrap text-left transition-opacity duration-300 ${dimClass({ kind: "pool", id: placed.name })}`}
            style={{
              left: placed.x + 2,
              top: placed.y + placed.h + 9,
              pointerEvents: "auto",
            }}
          >
            <span className="block text-[14px] font-semibold tracking-tight text-fg/90">
              {pool.name}
              {pool.scrubbing ? (
                <span className="ml-2 text-[11px] font-normal tracking-wide text-muted">
                  scrubbing
                </span>
              ) : null}
              {!pool.healthy ? (
                <span className="ml-2 text-[11px] font-normal tracking-wide text-warn">
                  {pool.healthLabel}
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block text-[11.5px] tabular-nums tracking-wide text-faint">
              {pool.usedLabel} <span className="text-faint/60">of {pool.totalLabel}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- instrument band --------------------------------------------------------------------------

function InstrumentBand({ scene, layout }: { scene: KineticScene; layout: KineticLayout }) {
  const { instrument } = scene;
  const cpu = instrument.cpu;
  const cellCols = cpu.cells.length > 32 ? Math.ceil(cpu.cells.length / 2) : cpu.cells.length;
  return (
    <header
      className="absolute inset-x-0 top-0 flex items-center gap-8 whitespace-nowrap border-b border-white/[0.05] px-7"
      style={{ height: layout.bandH }}
    >
      <div className="flex items-baseline gap-3">
        <span className="text-[13px] font-semibold tracking-[0.3em] text-fg">
          {scene.hostLabel.toUpperCase()}
        </span>
        {scene.demo ? (
          <span className="text-[10px] uppercase tracking-[0.24em] text-faint/70">
            demo data
          </span>
        ) : null}
      </div>

      {/* CPU: one cell per physical core (sibling threads averaged). */}
      <div className="flex items-center gap-4">
        <div
          className="grid gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${cellCols}, minmax(0, 1fr))` }}
          aria-hidden="true"
        >
          {cpu.cells.map((v, i) => (
            <span
              key={i}
              className="block h-[7px] w-[7px] rounded-[1.5px]"
              style={{
                backgroundColor: `rgba(214, 222, 232, ${0.07 + Math.min(1, Math.max(0, v)) * 0.8})`,
              }}
            />
          ))}
        </div>
        <div>
          <div className="text-[19px] font-semibold tabular-nums leading-none text-fg">
            {cpu.totalFraction !== null ? `${Math.round(cpu.totalFraction * 100)}%` : "—"}
          </div>
          <div className="mt-1 whitespace-nowrap text-[10px] uppercase tracking-[0.2em] text-faint">
            cpu{cpu.topologyLabel ? ` · ${cpu.topologyLabel}` : ""}
          </div>
        </div>
      </div>

      <BandGauge label="memory" gauge={instrument.memory} />
      {instrument.gpu.status !== "not-configured" ? (
        <BandGauge label="gpu" gauge={instrument.gpu} />
      ) : null}
      <BandGauge label="arc" gauge={instrument.arc} />

      <div className="ml-auto flex items-center gap-4">
        {scene.attention.headline ? (
          <span className="text-[12px] tracking-wide text-warn">
            {scene.attention.headline}
          </span>
        ) : null}
        {scene.fieldRunning !== null && scene.fieldTotal !== null ? (
          <span className="whitespace-nowrap text-[11px] uppercase tracking-[0.18em] text-faint/70">
            {scene.fieldRunning}/{scene.fieldTotal} workloads
          </span>
        ) : null}
      </div>
    </header>
  );
}

function BandGauge({
  label,
  gauge,
}: {
  label: string;
  gauge: { status: string; fraction: number | null; primary: string | null; secondary: string | null };
}) {
  if (gauge.status === "not-configured") return null;
  const unknown = gauge.fraction === null;
  return (
    <div className="w-40">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[16px] font-semibold tabular-nums leading-none text-fg">
          {gauge.primary ?? "—"}
        </span>
        {gauge.secondary ? (
          <span className="text-[10px] tabular-nums text-faint/70">{gauge.secondary}</span>
        ) : null}
      </div>
      <div className="mt-1.5 h-[3px] w-full rounded-full bg-white/[0.05]">
        {!unknown ? (
          <div
            className="h-full rounded-full bg-[rgba(214,222,232,0.55)] transition-[width] duration-700"
            style={{ width: `${Math.round((gauge.fraction ?? 0) * 100)}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-faint">{label}</div>
    </div>
  );
}
