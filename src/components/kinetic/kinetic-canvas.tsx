"use client";

/**
 * V4 Kinetic Flow Canvas — the stage component.
 *
 * Hybrid rendering: one Canvas 2D layer for light (glow pools, ribbons,
 * particles, workload field, storage strata) and a DOM overlay for every
 * piece of text and every interactive/accessible target.
 *
 * React never runs at frame cadence. Snapshots, selection and layout are
 * React's; frame time, interpolation, particle phase and every visual
 * envelope belong to the KineticEngine, which lives for the lifetime of the
 * mounted stage. React effects only move engine TARGETS — they can never
 * reset animation phase. The rAF loop parks itself whenever the engine
 * reports nothing moving (quiet scene, hidden tab, frozen clock, reduced
 * motion) and single-frames on parked data updates.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";
import type { DashboardSnapshot } from "@/lib/types";
import { formatRate } from "@/lib/format/bytes";
import {
  buildKineticScene,
  type AnchorModel,
  type KineticFlow,
  type KineticScene,
} from "@/lib/kinetic/model";
import {
  buildFlowPaths,
  buildKineticStage,
  stageGeometryKey,
  type KineticLayout,
  type KineticStage,
} from "@/lib/kinetic/layout";
import { KineticEngine } from "@/lib/kinetic/engine";
import {
  drawKineticFrame,
  type KineticSelection,
} from "@/lib/kinetic/render";

export interface KineticCanvasProps {
  snapshot: DashboardSnapshot;
  now: number;
  seerrConfigured: boolean;
  /** Frozen surfaces draw exactly one deterministic frame (no rAF). */
  frozen: boolean;
  surfaceLabel?: string;
  /** Expose bounded engine counters on window for the soak harness. */
  debugHook?: boolean;
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

interface ActiveDownloadRow {
  id: string;
  title: string;
  progress: number;
  progressLabel: string;
  rateLabel: string;
}

function activeDownloadRows(snapshot: DashboardSnapshot): ActiveDownloadRow[] {
  return snapshot.acquisition.items
    .filter(
      (item) =>
        item.state === "downloading" &&
        (item.source === "qbittorrent" || Boolean(item.correlationKey)),
    )
    .map((item) => {
      const progress = Number.isFinite(item.progress)
        ? Math.min(1, Math.max(0, item.progress))
        : 0;
      return {
        id: item.id,
        title: item.title,
        progress,
        progressLabel: Number.isFinite(item.progress) ? `${Math.round(progress * 100)}%` : "—",
        rateLabel: item.rateBps === null ? "—" : formatRate(item.rateBps),
      };
    });
}

function useStableDownloadRows(snapshot: DashboardSnapshot): ActiveDownloadRow[] {
  const rows = useMemo(() => activeDownloadRows(snapshot), [snapshot]);
  const orderRef = useRef<string[]>([]);
  return useMemo(() => {
    const current = new Set(rows.map((row) => row.id));
    const order = orderRef.current.filter((id) => current.has(id));
    for (const row of rows) {
      if (!order.includes(row.id)) order.push(row.id);
    }
    orderRef.current = order;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return order.map((id) => byId.get(id)!);
  }, [rows]);
}

function useDownloadPanelPresence() {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = useCallback(() => {
    if (graceTimer.current !== null) clearTimeout(graceTimer.current);
    if (exitTimer.current !== null) clearTimeout(exitTimer.current);
    graceTimer.current = null;
    exitTimer.current = null;
  }, []);
  const open = useCallback(() => {
    clearTimers();
    setPhase("open");
  }, [clearTimers]);
  const close = useCallback(() => {
    clearTimers();
    setPhase("closed");
  }, [clearTimers]);
  const scheduleClose = useCallback(() => {
    clearTimers();
    graceTimer.current = setTimeout(() => {
      setPhase("closing");
      exitTimer.current = setTimeout(() => setPhase("closed"), 140);
    }, 110);
  }, [clearTimers]);
  useEffect(() => clearTimers, [clearTimers]);
  return { phase, open, close, scheduleClose };
}

const FLOW_KIND_WORDS: Record<KineticFlow["kind"], string> = {
  "wan-transfer": "WAN transfer",
  "storage-transfer": "staging I/O",
  "import-copy": "import copy",
  "background-transfer": "background storage copy",
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
        : flow.treatment === "state-only" && flow.tone !== "control"
          ? " · rate unknown"
          : "";
  return `${FLOW_KIND_WORDS[flow.kind]} — ${flow.label}${rate}${state}`;
}

function compactFlowLine(flow: KineticFlow): string {
  if (flow.tone === "control") {
    return `${FLOW_KIND_WORDS[flow.kind]} · ${flow.label}`;
  }
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
      // Sit below the wordmark block: the inspector must never cover the
      // element that opened it.
      y: placed.y + 64,
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

const FOCUS_RING =
  "outline-none focus-visible:ring-1 focus-visible:ring-accent/70";

// --- component ---------------------------------------------------------------------------

export function KineticCanvas({
  snapshot,
  now,
  seerrConfigured,
  frozen,
  surfaceLabel = "Kinetic flow canvas",
  debugHook = false,
}: KineticCanvasProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { w, h } = useStageSize(stageRef);
  const reducedMotion = useReducedMotion();
  const pageVisible = usePageVisible();
  const [selection, setSelection] = useState<KineticSelection | null>(null);
  const [motionOn, setMotionOn] = useState(false);
  const downloadRows = useStableDownloadRows(snapshot);
  const downloadPanel = useDownloadPanelPresence();
  const downloadTriggerRef = useRef<HTMLButtonElement | null>(null);
  const downloadPanelRef = useRef<HTMLElement | null>(null);
  const downloadListRef = useRef<HTMLUListElement | null>(null);
  const pendingDownloadFocusRef = useRef(false);
  const focusDownloadPanelTarget = useCallback(() => {
    const target = downloadListRef.current ?? downloadPanelRef.current;
    if (!target) return false;
    target.focus();
    pendingDownloadFocusRef.current = false;
    return true;
  }, []);
  const downloadRegionContains = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node &&
      (downloadTriggerRef.current?.contains(target) === true ||
        downloadPanelRef.current?.contains(target) === true),
    [],
  );
  const blurDownloadRegion = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      if (!downloadRegionContains(event.relatedTarget)) {
        downloadPanel.scheduleClose();
      }
    },
    [downloadPanel, downloadRegionContains],
  );
  const enterDownloadPanel = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Tab" || event.shiftKey) return;
      event.preventDefault();
      pendingDownloadFocusRef.current = true;
      downloadPanel.open();
      focusDownloadPanelTarget();
    },
    [downloadPanel, focusDownloadPanelTarget],
  );

  useEffect(() => {
    if (downloadPanel.phase !== "open" || !pendingDownloadFocusRef.current) return;
    focusDownloadPanelTarget();
  }, [downloadPanel.phase, downloadRows.length, focusDownloadPanelTarget]);

  // ONE engine per mounted stage: its epoch — and therefore every particle's
  // phase — is established exactly once, here.
  const engineRef = useRef<KineticEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new KineticEngine(
      typeof performance !== "undefined" ? performance.now() : 0,
    );
  }

  const scene = useMemo(
    () => buildKineticScene(snapshot, { now, seerrConfigured }),
    [snapshot, now, seerrConfigured],
  );

  // STABLE geometry contract (V4 release blocker): stage placement is cached
  // against a key that telemetry-only updates cannot change. Rates, CPU,
  // memory and I/O move engine targets; only membership or viewport changes
  // recompute where anything sits. Flow paths ride on the cached stage, so a
  // flow appearing can never shift the composition either.
  const stageCache = useRef<{ key: string; stage: KineticStage } | null>(null);
  const layout = useMemo<KineticLayout | null>(() => {
    if (w <= 0 || h <= 0) return null;
    const key = stageGeometryKey(scene, w, h);
    if (stageCache.current?.key !== key) {
      stageCache.current = { key, stage: buildKineticStage(scene, w, h) };
    }
    const stage = stageCache.current.stage;
    return { ...stage, flows: buildFlowPaths(scene.flows, stage) };
  }, [scene, w, h]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Imperative painter: reads engine state, resizes the backing store in the
  // same pass it paints (no blank frame between resize and redraw).
  const paint = useCallback((t: number, still: boolean, marks: boolean, dprOverride?: number) => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    const currentLayout = layoutRef.current;
    if (!canvas || !engine || !currentLayout) return;
    const dpr = dprOverride ?? Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.round(currentLayout.w * dpr);
    const pixelH = Math.round(currentLayout.h * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawKineticFrame(ctx, engine.visualState(), currentLayout, { t, still, marks });
  }, []);

  // Single rAF loop, ref-guarded: at most one can ever exist, and it parks
  // itself the frame after the engine reports nothing moving.
  //
  // The paint cadence is capped at 60 Hz-class: on high-refresh displays
  // (120 Hz+) an ambient instrument gains nothing from doubling its main-
  // thread and raster work, so intermediate vsync callbacks are skipped
  // without advancing visual time. Motion quality is designed for 60 Hz;
  // energy discipline is part of a 24/7 surface.
  const MIN_PAINT_INTERVAL_MS = 15;
  const rafRef = useRef(0);
  const lastPaintAtRef = useRef(0);
  const stopLoop = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setMotionOn(false);
  }, []);
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const engine = engineRef.current!;
    const nowMs = performance.now();
    if (nowMs - lastPaintAtRef.current >= MIN_PAINT_INTERVAL_MS) {
      lastPaintAtRef.current = nowMs;
      const t = engine.frame(nowMs);
      paint(t, false, false);
      if (!engine.animating()) {
        rafRef.current = 0;
        setMotionOn(false);
        return;
      }
    }
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  };
  const startLoop = useCallback(() => {
    if (rafRef.current !== 0) return;
    setMotionOn(true);
    rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, []);
  useEffect(() => stopLoop, [stopLoop]);

  // Data → engine targets. This effect is the ONLY bridge from React to the
  // kinetic state: it moves targets and manages the loop, never phase.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !layout) return;
    engine.setSelection(selection);
    engine.syncTargets(scene, layout, {
      snap: frozen || reducedMotion,
      nowMs: performance.now(),
    });
    if (frozen || reducedMotion) {
      // Deterministic single frame: t derives from the explicit frozen clock,
      // never the live epoch. Reduced motion swaps particles for static
      // direction marks; a frozen live scene keeps its particle field placed
      // at the frozen t so screenshots show real motion state.
      stopLoop();
      paint((now % 100_000) / 1000, true, reducedMotion, frozen ? 1 : undefined);
      return;
    }
    if (!pageVisible) {
      // Hidden tab: stop all kinetic work. Visual time simply does not pass;
      // on return the same phase continues and the clamped delta prevents any
      // catch-up burst.
      stopLoop();
      return;
    }
    startLoop();
  }, [scene, layout, selection, frozen, reducedMotion, pageVisible, now, paint, startLoop, stopLoop]);

  // Bounded diagnostics for the soak harness (dev-controlled surfaces only).
  useEffect(() => {
    if (!debugHook) return;
    const devWindow = window as unknown as {
      __homelabKineticDebug?: () => {
        flows: number;
        decaying: number;
        cells: number;
        visibleParticles: number;
        rafActive: boolean;
        visualTime: number;
        visuals: Array<{
          id: string;
          kind: KineticFlow["kind"];
          treatment: KineticFlow["treatment"];
          rateBps: number | null;
          removed: boolean;
          missingSinceMs: number | null;
          particleSlots: number;
        }>;
      };
    };
    devWindow.__homelabKineticDebug = () => ({
      ...engineRef.current!.debugCounts(),
      rafActive: rafRef.current !== 0,
      visualTime: engineRef.current!.now(),
      visuals: engineRef.current!.visualState().flows.map((visual) => ({
        id: visual.id,
        kind: visual.flow.kind,
        treatment: visual.flow.treatment,
        rateBps: visual.flow.rateBps,
        removed: visual.removed,
        missingSinceMs: visual.missingSinceMs,
        particleSlots: visual.channels.reduce(
          (sum, channel) =>
            sum + channel.slotAlphas.filter((alpha) => alpha > 0.02).length,
          0,
        ),
      })),
    });
    return () => {
      delete devWindow.__homelabKineticDebug;
    };
  }, [debugHook]);

  // Focus restoration: the element that opened the inspector gets focus back
  // when the inspector closes, from whatever path (Escape, ×, re-toggle).
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeSelection = useCallback(() => {
    setSelection(null);
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target && target.isConnected) target.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selection) {
        event.preventDefault();
        closeSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, closeSelection]);

  const inspector = useMemo(
    () => (selection && layout ? inspectorFor(selection, scene, layout) : null),
    [selection, scene, layout],
  );

  const toggle = useCallback(
    (next: KineticSelection, initiator: HTMLElement | null) => {
      setSelection((prev) => {
        if (prev && prev.kind === next.kind && prev.id === next.id) {
          restoreFocusRef.current = null;
          return null;
        }
        restoreFocusRef.current = initiator;
        return next;
      });
    },
    [],
  );

  const cellsById = useMemo(() => {
    const map = new Map<string, { name: string; label: string }>();
    for (const group of scene.field) {
      for (const cell of group.cells) map.set(cell.id, { name: cell.name, label: group.label });
    }
    return map;
  }, [scene]);

  const compact = layout !== null && layout.w < 768;

  return (
    <div
      ref={stageRef}
      data-kinetic-stage
      data-motion={motionOn && !frozen && !reducedMotion ? "on" : "off"}
      className="relative h-full w-full overflow-hidden bg-[#07090d] text-fg select-none"
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === canvasRef.current) {
          closeSelection();
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
          downloadPanelOpen={downloadPanel.phase !== "closed"}
          openDownloadPanel={downloadPanel.open}
          closeDownloadPanel={downloadPanel.scheduleClose}
          dismissDownloadPanel={downloadPanel.close}
          downloadTriggerRef={downloadTriggerRef}
          enterDownloadPanel={enterDownloadPanel}
          blurDownloadRegion={blurDownloadRegion}
        />
      ) : null}

      {layout && downloadPanel.phase !== "closed" ? (
        <DownloadPanel
          rows={downloadRows}
          scene={scene}
          layout={layout}
          closing={downloadPanel.phase === "closing"}
          onEnter={downloadPanel.open}
          onLeave={downloadPanel.scheduleClose}
          panelRef={downloadPanelRef}
          listRef={downloadListRef}
          triggerRef={downloadTriggerRef}
          onBlur={blurDownloadRegion}
        />
      ) : null}

      {inspector && layout ? (
        <aside
          data-kinetic-inspector
          aria-label={`${inspector.title} inspector`}
          className={
            compact
              ? "absolute inset-x-0 bottom-0 z-30 rounded-t-xl border-t border-white/[0.07] bg-[#0d1016]/95 px-5 pb-5 pt-4 shadow-[0_-12px_40px_rgba(0,0,0,0.5)] backdrop-blur-sm"
              : "absolute z-30 w-64 rounded-lg border border-white/[0.07] bg-[#0d1016]/95 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-sm"
          }
          style={
            compact
              ? undefined
              : {
                  left: Math.min(Math.max(inspector.x - 128, 12), layout.w - 268),
                  top: Math.min(Math.max(inspector.y - 12, layout.bandH + 8), layout.h - 220),
                }
          }
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight text-fg">
              {inspector.title}
            </h2>
            <button
              type="button"
              aria-label="Close inspector"
              className={`rounded px-1 text-faint transition-opacity hover:opacity-70 ${FOCUS_RING}`}
              onClick={closeSelection}
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

function DownloadPanel({
  rows,
  scene,
  layout,
  closing,
  onEnter,
  onLeave,
  panelRef,
  listRef,
  triggerRef,
  onBlur,
}: {
  rows: ActiveDownloadRow[];
  scene: KineticScene;
  layout: KineticLayout;
  closing: boolean;
  onEnter: () => void;
  onLeave: () => void;
  panelRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLUListElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
}) {
  const anchor = layout.anchors.find((candidate) => candidate.id === "qbittorrent")!;
  const model = scene.anchors.find((candidate) => candidate.id === "qbittorrent")!;
  const panelW = 320;
  const gap = Math.max(62, anchor.r * 0.72);
  const fitsRight = anchor.x + gap + panelW <= layout.w - 12;
  const left = fitsRight
    ? anchor.x + gap
    : Math.max(12, anchor.x - gap - panelW);
  const top = Math.min(
    Math.max(layout.bandH + 12, anchor.y - 78),
    Math.max(layout.bandH + 12, layout.h - 360),
  );
  const qualification =
    model.status === "down"
      ? "unavailable · last known"
      : model.status === "degraded"
        ? "data may be stale"
        : null;

  return (
    <aside
      ref={panelRef}
      id="qbittorrent-download-panel"
      role="region"
      tabIndex={-1}
      data-download-panel
      aria-labelledby="qbittorrent-download-panel-title"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Tab" && event.shiftKey) {
          event.preventDefault();
          triggerRef.current?.focus();
        }
      }}
      className={`absolute z-20 w-[320px] origin-top-left rounded-xl border border-white/[0.08] bg-[#0d1016]/[0.97] px-3 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.48)] backdrop-blur-sm transition-[opacity,transform] duration-[140ms] ease-out ${
        closing ? "pointer-events-none translate-y-1 scale-[0.985] opacity-0" : "opacity-100"
      }`}
      style={{
        left,
        top,
        pointerEvents: closing ? "none" : "auto",
        animation: closing ? undefined : "kinetic-panel-in 140ms ease-out",
      }}
    >
      <div className="flex items-baseline justify-between gap-3 px-1 pb-2">
        <div>
          <h2
            id="qbittorrent-download-panel-title"
            className="text-[13px] font-semibold tracking-tight text-fg"
          >
            Active downloads
          </h2>
          {qualification ? (
            <p className="mt-0.5 text-[10px] tracking-wide text-warn">{qualification}</p>
          ) : null}
        </div>
        {rows.length > 0 ? (
          <span className="text-[11px] tabular-nums text-faint">{rows.length}</span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="border-t border-white/[0.06] px-1 py-3 text-[12px] text-faint">
          No active downloads
        </p>
      ) : (
        <ul
          ref={listRef}
          data-download-list
          tabIndex={0}
          aria-label="Active downloads list"
          onKeyDown={(event) => {
            if (event.key === "Tab" && event.shiftKey) {
              event.preventDefault();
              triggerRef.current?.focus();
            }
          }}
          className={`max-h-64 overflow-y-auto overscroll-contain border-t border-white/[0.06] pr-1 [scrollbar-width:thin] ${FOCUS_RING}`}
        >
          {rows.map((row) => (
            <li
              key={row.id}
              data-download-row={row.id}
              className="relative grid min-h-10 grid-cols-[minmax(0,1fr)_48px_76px] items-center gap-2 border-b border-white/[0.045] px-1 last:border-b-0"
              aria-label={`${row.title}; ${row.progressLabel}; ${row.rateLabel}`}
            >
              <span
                title={row.title}
                className="w-[13ch] max-w-full truncate whitespace-nowrap text-[12px] text-fg"
              >
                {row.title}
              </span>
              <span className="text-right text-[11px] tabular-nums text-muted">
                {row.progressLabel}
              </span>
              <span className="text-right text-[11px] tabular-nums text-fg/85">
                {row.rateLabel}
              </span>
              <span
                aria-hidden="true"
                className="absolute inset-x-1 bottom-0 h-px origin-left bg-accent/35 transition-transform duration-500"
                style={{ transform: `scaleX(${row.progress})` }}
              />
            </li>
          ))}
        </ul>
      )}
    </aside>
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
  downloadPanelOpen,
  openDownloadPanel,
  closeDownloadPanel,
  dismissDownloadPanel,
  downloadTriggerRef,
  enterDownloadPanel,
  blurDownloadRegion,
}: {
  scene: KineticScene;
  layout: KineticLayout;
  selection: KineticSelection | null;
  toggle: (next: KineticSelection, initiator: HTMLElement | null) => void;
  cellsById: Map<string, { name: string; label: string }>;
  surfaceLabel: string;
  downloadPanelOpen: boolean;
  openDownloadPanel: () => void;
  closeDownloadPanel: () => void;
  dismissDownloadPanel: () => void;
  downloadTriggerRef: RefObject<HTMLButtonElement | null>;
  enterDownloadPanel: (event: ReactKeyboardEvent<HTMLElement>) => void;
  blurDownloadRegion: (event: ReactFocusEvent<HTMLElement>) => void;
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

  // Roving keyboard navigation for the workload field: the entire field is
  // ONE tab stop; arrows walk the population in visual (group, cell) order.
  // 40+ tiny sequential tab stops would be hostile; this is the grouped
  // pattern the review required.
  const cellOrder = useMemo(
    () =>
      [...layout.groups]
        .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
        .flatMap((group) =>
          [...group.cells]
            .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
            .map((cell) => cell.id),
        ),
    [layout],
  );
  const [rovingId, setRovingId] = useState<string | null>(null);
  const activeRovingId =
    rovingId !== null && cellOrder.includes(rovingId) ? rovingId : cellOrder[0] ?? null;
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());

  const onFieldKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (cellOrder.length === 0 || activeRovingId === null) return;
      const index = cellOrder.indexOf(activeRovingId);
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (index + 1) % cellOrder.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (index - 1 + cellOrder.length) % cellOrder.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = cellOrder.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      const id = cellOrder[nextIndex]!;
      setRovingId(id);
      cellRefs.current.get(id)?.focus();
    },
    [cellOrder, activeRovingId],
  );

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
            data-kinetic-orchestrator={placed.id}
            aria-label={`${model.label}; ${model.detail ?? "idle"}`}
            className={`absolute -translate-x-1/2 -translate-y-1/2 text-center transition-[color,opacity,text-shadow] duration-500 ${dimClass({ kind: "orchestrator", id: placed.id })}`}
            style={{ left: placed.x, top: placed.y }}
          >
            <div
              className={`text-[20px] font-semibold tracking-[-0.015em] transition-colors duration-500 ${
                model.active ? "text-fg" : "text-muted/75"
              }`}
            >
              {model.label}
            </div>
            {model.detail ? (
              <div
                className={`mt-1 text-[12px] tabular-nums tracking-wide transition-colors duration-500 ${
                  model.active ? "text-muted" : "text-faint/75"
                }`}
              >
                {model.detail}
              </div>
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
            ref={placed.id === "qbittorrent" ? downloadTriggerRef : undefined}
            key={placed.id}
            type="button"
            data-kinetic-anchor={placed.id}
            aria-label={`${model.label}${model.headline ? `; ${model.headline}` : idle ? "; idle" : ""}`}
            aria-expanded={placed.id === "qbittorrent" ? downloadPanelOpen : undefined}
            aria-controls={placed.id === "qbittorrent" ? "qbittorrent-download-panel" : undefined}
            onMouseEnter={placed.id === "qbittorrent" ? openDownloadPanel : undefined}
            onMouseLeave={placed.id === "qbittorrent" ? closeDownloadPanel : undefined}
            onFocus={placed.id === "qbittorrent" ? openDownloadPanel : undefined}
            onBlur={placed.id === "qbittorrent" ? blurDownloadRegion : undefined}
            onKeyDown={placed.id === "qbittorrent" ? enterDownloadPanel : undefined}
            onClick={(event) => {
              if (placed.id === "qbittorrent") dismissDownloadPanel();
              toggle({ kind: "anchor", id: placed.id }, event.currentTarget);
            }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-md text-center transition-opacity duration-300 ${FOCUS_RING} ${dimClass({ kind: "anchor", id: placed.id })}`}
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

      {/* Workload field: one roving tab stop + selective labels + captions. */}
      <div
        role="group"
        aria-label={`Workloads (${cellOrder.length}); use arrow keys to move between them`}
        onKeyDown={onFieldKeyDown}
      >
        {layout.groups.map((group) => (
          <div key={group.id}>
            <div
              className="absolute -translate-x-1/2 text-[11px] font-medium uppercase tracking-[0.26em] text-faint/55"
              style={{ left: group.cx, top: group.labelY }}
            >
              {group.label}
              {group.overflowCount > 0 ? ` +${group.overflowCount}` : ""}
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
                  data-kinetic-cell={placed.id}
                  ref={(el) => {
                    if (el) cellRefs.current.set(placed.id, el);
                    else cellRefs.current.delete(placed.id);
                  }}
                  tabIndex={placed.id === activeRovingId ? 0 : -1}
                  aria-label={`${info.name}; ${info.label}${cell.attention ? "; needs attention" : ""}`}
                  onFocus={() => setRovingId(placed.id)}
                  onClick={(event) =>
                    toggle({ kind: "cell", id: placed.id }, event.currentTarget)
                  }
                  className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-[8px] ${FOCUS_RING}`}
                  style={{
                    left: placed.x,
                    top: placed.y,
                    width: Math.max(placed.slot, 16),
                    height: Math.max(placed.slot, 16),
                    pointerEvents: "auto",
                  }}
                >
                  <span className="sr-only">{info.name}</span>
                </button>
              );
            })}
            {group.cells.map((placed, placedIndex) => {
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
                  style={{
                    left: placed.x,
                    top: placed.y + placed.r + 5 + (placedIndex % 2) * 10,
                  }}
                >
                  {cell.name}
                </div>
              );
            })}
          </div>
        ))}
      </div>

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
            onClick={(event) =>
              toggle({ kind: "pool", id: placed.name }, event.currentTarget)
            }
            className={`absolute whitespace-nowrap rounded-md text-left transition-opacity duration-300 ${FOCUS_RING} ${dimClass({ kind: "pool", id: placed.name })}`}
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
              className="block h-[7px] w-[7px] rounded-[1.5px] transition-colors duration-700"
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
