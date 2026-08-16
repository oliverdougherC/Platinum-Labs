"use client";

import { useEffect, useMemo, useRef } from "react";
import { sampleBlend, samplePath, norm, sub, vec } from "@/lib/scene/geom";
import {
  drawControlSignal,
  drawTunnel,
  PRODUCTION_FLOW_STYLE,
  type FlowDrawEnv,
  type FlowStyle,
} from "@/lib/scene/render";
import { widthFromRate } from "@/lib/topology/smoothing";
import { colorTokens } from "@/lib/design/tokens";
import type { LiveFlow } from "@/lib/scene/motion";
import type { FlowGeom } from "@/lib/scene/routing";
import type { FlowChannel, FlowObservation } from "@/lib/topology/activity";

/**
 * Flow laboratory (dev-only): the eleven canonical flow states, each drawn by
 * the PRODUCTION drawing code on an isolated conduit, under a switchable
 * tunnel treatment. This page is the design-study artifact for the PLA-266
 * v2 tunnel language — the chosen treatment ships as PRODUCTION_FLOW_STYLE.
 */

const TREATMENTS: Record<string, { style: FlowStyle; note: string }> = {
  A: {
    style: PRODUCTION_FLOW_STYLE,
    note: "A — centerline highlight, tapered streaks (production)",
  },
  B: {
    style: { ...PRODUCTION_FLOW_STYLE, highlight: "rails", glowScale: 2.6, bodyAlpha: 0.2 },
    note: "B — twin edge rails, denser body, tighter glow",
  },
  C: {
    style: { ...PRODUCTION_FLOW_STYLE, highlight: "both", particle: "point", glowScale: 4.2, glowAlpha: 0.13 },
    note: "C — rails + centerline, point particles, wide atmosphere",
  },
};

interface LabCase {
  title: string;
  subtitle: string;
  /** null = draw only the dormant structural path. */
  make: () => { obs: FlowObservation; live: Omit<LiveFlow, "obs"> } | null;
}

function obsOf(
  id: string,
  over: Partial<FlowObservation>,
  channels: FlowChannel[],
): FlowObservation {
  return {
    id,
    kind: "wan-transfer",
    plane: "data",
    from: { kind: "network" },
    to: { kind: "service", id: "qbittorrent" },
    evidence: "measured",
    freshness: "live",
    channels,
    provenance: "flow laboratory",
    label: id,
    updatedAt: null,
    ...over,
  };
}

function liveOf(forwardBps: number | null, reverseBps: number | null, activity = 1) {
  const forwardWidth = widthFromRate(forwardBps);
  const reverseWidth = widthFromRate(reverseBps);
  return {
    present: true,
    forwardWidth,
    reverseWidth,
    width: Math.max(forwardWidth, reverseWidth),
    activity,
  };
}

const fwd = (bps: number | null): FlowChannel => ({
  direction: "forward",
  role: "ingress",
  bytesPerSecond: bps,
});
const rev = (bps: number | null): FlowChannel => ({
  direction: "reverse",
  role: "egress",
  bytesPerSecond: bps,
});

const CASES: LabCase[] = [
  { title: "dormant route", subtitle: "topology exists, nothing moving", make: () => null },
  {
    title: "32 KB/s · measured",
    subtitle: "one patient packet, hairline tunnel",
    make: () => ({ obs: obsOf("lab-32k", {}, [fwd(32_000)]), live: liveOf(32_000, null) }),
  },
  {
    title: "5 MB/s · measured",
    subtitle: "moderate working traffic",
    make: () => ({ obs: obsOf("lab-5m", {}, [fwd(5_000_000)]), live: liveOf(5_000_000, null) }),
  },
  {
    title: "100 MB/s · measured",
    subtitle: "heavy transfer",
    make: () => ({ obs: obsOf("lab-100m", {}, [fwd(100_000_000)]), live: liveOf(100_000_000, null) }),
  },
  {
    title: "1.25 GB/s · clamped",
    subtitle: "near-10GbE — width must stay bounded",
    make: () => ({ obs: obsOf("lab-10g", {}, [fwd(1_250_000_000)]), live: liveOf(1_250_000_000, null) }),
  },
  {
    title: "bidirectional · 8 MB/s ↓ · 900 KB/s ↑",
    subtitle: "one conduit, two offset populations",
    make: () => ({
      obs: obsOf("lab-bidi", {}, [fwd(8_000_000), rev(900_000)]),
      live: liveOf(8_000_000, 900_000),
    }),
  },
  {
    title: "bidirectional · 10 MB/s ↓ · 9 MB/s ↑",
    subtitle: "near-equal — stable shared body, directional particles",
    make: () => ({
      obs: obsOf("lab-bidi-balanced", {}, [fwd(10_000_000), rev(9_000_000)]),
      live: liveOf(10_000_000, 9_000_000),
    }),
  },
  {
    title: "derived · 2.3 MB/s",
    subtitle: "softer treatment, fewer particles",
    make: () => ({
      obs: obsOf("lab-derived", { evidence: "derived", kind: "playback", channels: [] }, [
        { direction: "forward", role: "read", bytesPerSecond: 2_300_000 },
      ]),
      live: liveOf(2_300_000, null),
    }),
  },
  {
    title: "state-only control signal",
    subtitle: "discrete pulse — never a tunnel",
    make: () => ({
      obs: obsOf("lab-ctl", { plane: "control", kind: "control", evidence: "state-only" }, [
        { direction: "forward", role: "egress", bytesPerSecond: null },
      ]),
      live: liveOf(null, null, 1),
    }),
  },
  {
    title: "stale · last known 6 MB/s",
    subtitle: "frozen ghost — no motion, no excitation",
    make: () => ({
      obs: obsOf("lab-stale", { freshness: "stale" }, [fwd(6_000_000)]),
      live: liveOf(6_000_000, null, 0.4),
    }),
  },
  {
    title: "unavailable · removed fade",
    subtitle: "body releases; particles and endpoints stop immediately",
    make: () => ({
      obs: obsOf("lab-removed", {}, [fwd(6_000_000)]),
      live: { ...liveOf(6_000_000, null, 0.35), present: false },
    }),
  },
];

const CELL_W = 560;
const CELL_H = 190;

function cellGeom(obs: FlowObservation | null): FlowGeom {
  const a = vec(70, CELL_H * 0.68);
  const b = vec(CELL_W - 70, CELL_H * 0.42);
  const ta = norm(sub(vec(CELL_W * 0.4, CELL_H * 0.1), a));
  const tb = norm(sub(b, vec(CELL_W * 0.6, CELL_H * 0.95)));
  const points = sampleBlend(a, ta, b, tb, 64);
  return {
    flow:
      obs ??
      obsOf("lab-dormant", {}, []),
    path: samplePath(points),
    ports: { from: points[0]!, to: points[points.length - 1]! },
  };
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  labCase: LabCase,
  t: number,
  style: FlowStyle,
  motionEnabled: boolean,
): void {
  const [br, bg, bb] = colorTokens.bg;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, CELL_W, CELL_H);
  ctx.lineCap = "round";

  const made = labCase.make();
  const geom = cellGeom(made?.obs ?? null);

  // Endpoint bodies for port context.
  const [hr, hg, hb] = colorTokens.border;
  ctx.strokeStyle = `rgba(${hr},${hg},${hb},0.8)`;
  ctx.lineWidth = 1.1;
  for (const port of [geom.ports.from, geom.ports.to]) {
    ctx.beginPath();
    ctx.arc(port.x + (port === geom.ports.from ? -26 : 26), port.y, 24, 0, Math.PI * 2);
    ctx.stroke();
  }

  const env: FlowDrawEnv = { t, motionEnabled, hovered: null };
  if (!made) {
    const [fr, fg2, fb] = colorTokens.hairline;
    ctx.strokeStyle = `rgba(${fr},${fg2},${fb},0.28)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const pts = geom.path.points;
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }

  const f = { geom, live: { obs: made.obs, ...made.live } };
  const budget = { left: style.particleBudget };
  if (made.obs.plane === "control") drawControlSignal(ctx, env, f);
  else drawTunnel(ctx, env, f, style, budget);
}

export function FlowLab({ treatment, fixedT }: { treatment: string; fixedT: number | null }) {
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const chosen = TREATMENTS[treatment] ?? TREATMENTS.A!;
  const style = chosen.style;

  const dpr = useMemo(
    () => (typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2)),
    [],
  );

  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const drawAll = (t: number) => {
      CASES.forEach((c, i) => {
        const canvas = canvases.current[i];
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCell(ctx, c, t, style, true);
      });
    };
    if (fixedT !== null) {
      drawAll(fixedT);
      return;
    }
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      drawAll((ts - t0) / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [style, fixedT, dpr]);

  return (
    <main className="min-h-screen bg-bg p-8 text-fg">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-lg">Flow laboratory</h1>
          <p className="text-sm text-muted">{chosen.note}</p>
        </div>
        <nav className="flex gap-3 text-sm">
          {Object.keys(TREATMENTS).map((k) => (
            <a
              key={k}
              href={`?treatment=${k}${fixedT !== null ? `&t=${fixedT}` : ""}`}
              className={k === treatment ? "text-accent" : "text-muted hover:text-fg"}
            >
              treatment {k}
            </a>
          ))}
        </nav>
      </header>
      <div className="grid grid-cols-2 gap-4" data-testid="flow-lab-grid">
        {CASES.map((c, i) => (
          <figure key={c.title} className="rounded-md border border-hairline/60 p-3">
            <canvas
              ref={(el) => {
                canvases.current[i] = el;
              }}
              width={CELL_W * dpr}
              height={CELL_H * dpr}
              style={{ width: CELL_W, height: CELL_H }}
            />
            <figcaption className="mt-2 text-sm">
              {c.title}
              <span className="ml-2 text-xs text-faint">{c.subtitle}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}
