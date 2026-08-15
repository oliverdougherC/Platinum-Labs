/**
 * Label system (PLA-266 rebuild) — typography is part of the scene design.
 *
 * Labels are computed in WORLD coordinates here (so tests can check collision
 * and containment) and rendered as a DOM overlay by the React host (so text
 * stays crisp at any devicePixelRatio, and screen readers get real text).
 *
 * Placement rules:
 *  - service labels sit radially OUTSIDE the orbit, so they never collide
 *    with the orbit guide, the lane, or each other;
 *  - storage labels hang below their body's atmosphere;
 *  - the core label sits below the star, clear of both lane hemispheres;
 *  - secondary lines are quiet (smaller, fainter) and only exist when they
 *    carry real state.
 */

import { formatCapacityPair, formatRate } from "@/lib/format/bytes";
import { formatBytes } from "@/lib/format/bytes";
import { formatPercent, formatRelativeTime } from "@/lib/utils";
import { pointOnCircle, type Vec } from "@/lib/scene/geom";
import type { SceneLayout } from "@/lib/scene/layout";
import type { SceneModel } from "@/lib/scene/model";

export type LabelTone = "fg" | "muted" | "faint" | "warn" | "danger";

export interface LabelSpec {
  id: string;
  /** World-space anchor; the DOM overlay centers the text block on x. */
  anchor: Vec;
  primary: string;
  primaryTone: LabelTone;
  secondary: string | null;
  secondaryTone: LabelTone;
  /** Approximate world-space box (for collision/containment tests). */
  box: { w: number; h: number };
}

/** Primary/secondary font sizes in world units (scaled with the camera). */
export const LABEL_PRIMARY_PX = 14.5;
export const LABEL_SECONDARY_PX = 11.5;

const CHAR_W = 0.58; // average glyph width as a fraction of font size

function box(primary: string, secondary: string | null): { w: number; h: number } {
  const w = Math.max(
    primary.length * LABEL_PRIMARY_PX * CHAR_W,
    (secondary?.length ?? 0) * LABEL_SECONDARY_PX * CHAR_W,
  );
  const h = LABEL_PRIMARY_PX + (secondary ? LABEL_SECONDARY_PX + 4 : 0) + 6;
  return { w, h };
}

function label(
  id: string,
  anchor: Vec,
  primary: string,
  opts: {
    primaryTone?: LabelTone;
    secondary?: string | null;
    secondaryTone?: LabelTone;
  } = {},
): LabelSpec {
  const secondary = opts.secondary ?? null;
  return {
    id,
    anchor,
    primary,
    primaryTone: opts.primaryTone ?? "muted",
    secondary,
    secondaryTone: opts.secondaryTone ?? "faint",
    box: box(primary, secondary),
  };
}

export function buildLabels(model: SceneModel, layout: SceneLayout, now: number): LabelSpec[] {
  const labels: LabelSpec[] = [];
  const core = layout.core;

  // --- core -------------------------------------------------------------------
  const cpu = model.core;
  const cpuText =
    cpu.status === "available" || cpu.status === "stale"
      ? `${model.core.hostname} — ${cpu.totalFraction !== null ? formatPercent(cpu.totalFraction) : "—"}`
      : `${model.core.hostname} — cpu ${cpu.status === "not-configured" ? "not collected" : cpu.status}`;
  const memText =
    cpu.memUsedBytes !== null && cpu.memTotalBytes !== null
      ? `mem ${formatBytes(cpu.memUsedBytes, { system: "binary", digits: 0 })} / ${formatBytes(cpu.memTotalBytes, { system: "binary", digits: 0 })}`
      : null;
  const loadText = cpu.load1 !== null ? `load ${cpu.load1.toFixed(2)}` : null;
  const coreSecondary = [loadText, memText].filter(Boolean).join(" · ") || null;
  labels.push(
    label("core", pointOnCircle(core.center, core.boundaryR + 14, Math.PI / 2), cpuText, {
      primaryTone: cpu.status === "available" ? "fg" : "faint",
      secondary: coreSecondary,
    }),
  );

  // --- services ---------------------------------------------------------------
  for (const s of model.services) {
    const g = layout.services.get(s.id);
    if (!g) continue;
    const statusLine =
      s.status === "down"
        ? "unreachable"
        : s.status === "degraded"
          ? "stale"
          : s.status === "not-configured"
            ? "not set up"
            : s.status === "neutral"
              ? "on demand"
              : s.detail;
    const count = s.count !== null ? ` · ${s.count}` : "";
    labels.push(
      label(`service:${s.id}`, g.labelAnchor, s.label, {
        primaryTone: s.status === "down" ? "danger" : s.status === "degraded" ? "warn" : "muted",
        secondary: statusLine ? `${statusLine}${count}` : count ? count.slice(3) : null,
        secondaryTone:
          s.status === "down" ? "danger" : s.status === "degraded" ? "warn" : "faint",
      }),
    );
  }

  // --- storage ----------------------------------------------------------------
  for (const pool of model.storage) {
    const g = layout.storage.get(pool.name);
    if (!g) continue;
    const capacity = formatCapacityPair(
      pool.capacityLabelBytes.used,
      pool.capacityLabelBytes.total,
    );
    const basis = pool.capacityBasis === "pool-allocation" ? " (pool alloc)" : "";
    const statusLine = !pool.healthy
      ? `${pool.healthLabel}${pool.scrubErrors > 0 ? ` · ${pool.scrubErrors} errors` : ""}`
      : pool.scrubbing
        ? "scrubbing"
        : pool.lastScrubAt
          ? `scrubbed ${formatRelativeTime(pool.lastScrubAt, now)}`
          : formatPercent(pool.capacityFraction);
    labels.push(
      label(`pool:${pool.name}`, g.labelAnchor, pool.name, {
        primaryTone: pool.healthy ? "fg" : "danger",
        secondary: `${capacity}${basis} · ${statusLine}`,
        secondaryTone: pool.healthy ? "faint" : "danger",
      }),
    );
  }
  if (layout.genericStorage) {
    labels.push(
      label("storage:generic", layout.genericStorage.labelAnchor, "storage", {
        primaryTone: "faint",
        secondary: "no media pool declared",
      }),
    );
  }

  // --- network ----------------------------------------------------------------
  const netAnchor = pointOnCircle(
    layout.networkArc.center,
    layout.networkArc.r + 34,
    Math.PI,
  );
  const net = model.network;
  labels.push(
    label("network", netAnchor, "network", {
      primaryTone: "faint",
      secondary:
        net.rxBps !== null && net.txBps !== null
          ? `↓ ${formatRate(net.rxBps)} · ↑ ${formatRate(net.txBps)}`
          : net.status === "not-configured"
            ? "not collected"
            : net.status,
    }),
  );

  // --- docker belt ------------------------------------------------------------
  if (model.docker.status !== "not-configured") {
    const beltMid = (layout.dockerBelt.a0 + layout.dockerBelt.a1) / 2;
    const anchor = pointOnCircle(layout.dockerBelt.center, layout.dockerBelt.r + 44, beltMid);
    labels.push(
      label("docker", anchor, "containers", {
        primaryTone: "faint",
        secondary:
          model.docker.running !== null && model.docker.total !== null
            ? `${model.docker.running}/${model.docker.total} running${
                model.docker.unhealthy ? ` · ${model.docker.unhealthy} unhealthy` : ""
              }`
            : model.docker.status,
        secondaryTone: model.docker.unhealthy ? "warn" : "faint",
      }),
    );
  }

  return labels;
}

/** Axis-aligned overlap test between two label boxes (for tests). */
export function labelsOverlap(a: LabelSpec, b: LabelSpec): boolean {
  const ax0 = a.anchor.x - a.box.w / 2;
  const ax1 = a.anchor.x + a.box.w / 2;
  const bx0 = b.anchor.x - b.box.w / 2;
  const bx1 = b.anchor.x + b.box.w / 2;
  const ay0 = a.anchor.y;
  const ay1 = a.anchor.y + a.box.h;
  const by0 = b.anchor.y;
  const by1 = b.anchor.y + b.box.h;
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
}
