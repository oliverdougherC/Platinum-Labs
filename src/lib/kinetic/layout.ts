/**
 * V4 Kinetic Flow Canvas — layout.
 *
 * Resolves the scene view model into stage geometry for a given viewport.
 * Fully deterministic: identical scene + identical stage size → identical
 * geometry (cluster placement uses id hashes, never randomness), which the
 * frozen screenshot harness depends on.
 */

import type {
  FieldCellModel,
  KineticFlow,
  KineticNodeRef,
  KineticScene,
} from "./model";

export interface Pt {
  x: number;
  y: number;
}

/** A cubic bézier sampled into a polyline with cumulative arc length. */
export interface SampledPath {
  points: Pt[];
  /** Cumulative length at each sample; last entry is the total length. */
  lengths: number[];
  total: number;
}

export function samplePath(p0: Pt, c1: Pt, c2: Pt, p1: Pt, samples = 72): SampledPath {
  const points: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    points.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
    });
  }
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    lengths.push(lengths[i - 1]! + Math.hypot(dx, dy));
  }
  return { points, lengths, total: lengths[lengths.length - 1]! };
}

/** Point + unit tangent at arc distance `d` (clamped to the path). */
export function pointAt(path: SampledPath, d: number): { x: number; y: number; tx: number; ty: number } {
  const dist = Math.min(Math.max(d, 0), path.total);
  // Binary search over cumulative lengths.
  let lo = 0;
  let hi = path.lengths.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.lengths[mid]! < dist) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const l0 = path.lengths[i - 1]!;
  const l1 = path.lengths[i]!;
  const f = l1 > l0 ? (dist - l0) / (l1 - l0) : 0;
  const a = path.points[i - 1]!;
  const b = path.points[i]!;
  const x = a.x + (b.x - a.x) * f;
  const y = a.y + (b.y - a.y) * f;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x, y, tx: (b.x - a.x) / len, ty: (b.y - a.y) / len };
}

// --- stage regions -----------------------------------------------------------------

export interface AnchorPlacement {
  id: "qbittorrent" | "jellyfin";
  x: number;
  y: number;
  /** Glow pool radius. */
  r: number;
}

export interface OrchestratorPlacement {
  id: "seerr" | "sonarr" | "radarr";
  x: number;
  y: number;
}

export interface EdgePlacement {
  id: "wan" | "clients";
  x: number;
  y: number;
  side: "left" | "right";
}

export interface CellPlacement {
  id: string;
  x: number;
  y: number;
  r: number;
}

export interface GroupPlacement {
  id: string;
  label: string;
  cx: number;
  cy: number;
  labelY: number;
  cells: CellPlacement[];
}

export interface StratumPlacement {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowPlacement {
  id: string;
  path: SampledPath;
}

/** Everything about the stage that must stay FIXED across telemetry updates. */
export interface KineticStage {
  w: number;
  h: number;
  bandH: number;
  orchY: number;
  anchorY: number;
  anchors: AnchorPlacement[];
  orchestrators: OrchestratorPlacement[];
  edges: EdgePlacement[];
  groups: GroupPlacement[];
  strata: StratumPlacement[];
  storageTop: number;
  /** Cell radius range, exposed so size changes can ease without re-layout. */
  cellRMin: number;
  cellRMax: number;
}

export interface KineticLayout extends KineticStage {
  flows: FlowPlacement[];
}

/**
 * The inputs the STAGE geometry actually depends on. Telemetry-only updates
 * (rates, CPU, memory, I/O) never change this key, so major geometry can be
 * cached against it and provably cannot move between snapshots — only
 * membership or viewport changes recompute placement.
 */
export function stageGeometryKey(scene: KineticScene, w: number, h: number): string {
  return JSON.stringify({
    w,
    h,
    groups: scene.field.map((g) => ({
      id: g.id,
      cells: g.cells.map((c) => c.id),
    })),
    storage: scene.storage.map((s) => ({ name: s.name, total: s.totalBytes })),
  });
}

// Small deterministic hash → 0..1 (same recipe as the fake series wobble).
export function hash01(text: string, salt: number): number {
  let acc = salt * 374761393;
  for (let i = 0; i < text.length; i++) {
    acc = (acc ^ text.charCodeAt(i)) * 668265263;
    acc |= 0;
  }
  const v = Math.sin(acc) * 43758.5453;
  return v - Math.floor(v);
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface CellBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Bounded deterministic separation pass over one group's golden-angle seed
 * placement (V4 collision hardening). Not a physics simulation: a fixed
 * number of symmetric pairwise relaxation sweeps in a fixed id order, then a
 * hard clamp to the group's territory. Identical input → identical output,
 * and placement settles once — it never keeps moving between telemetry
 * updates because it is only ever computed when membership/viewport change.
 * Labeled cells claim extra clearance so their name rows cannot sit on a
 * neighbor; attention labels (always visible) get the most.
 */
function separateCells(
  placed: CellPlacement[],
  clearance: Map<string, number>,
  bounds: CellBounds,
): void {
  const ITERATIONS = 28;
  const clamp = (cell: CellPlacement) => {
    cell.x = Math.min(Math.max(cell.x, bounds.minX + cell.r), bounds.maxX - cell.r);
    cell.y = Math.min(Math.max(cell.y, bounds.minY + cell.r), bounds.maxY - cell.r);
  };
  for (const cell of placed) clamp(cell);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        const need =
          a.r + b.r + 3 + (clearance.get(a.id) ?? 0) + (clearance.get(b.id) ?? 0);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d < 1e-6) {
          // Deterministic tie-break for exactly coincident seeds.
          const angle = hash01(`${a.id}|${b.id}`, 7) * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        const push = (need - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        clamp(a);
        clamp(b);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function placeCells(
  cells: FieldCellModel[],
  cx: number,
  cy: number,
  spread: number,
  rMin: number,
  rMax: number,
  bounds: CellBounds,
): CellPlacement[] {
  // Largest bodies gravitate to the cluster core; a stable sort on the id
  // breaks score ties deterministically.
  const ordered = [...cells].sort(
    (a, b) => b.sizeScore - a.sizeScore || a.id.localeCompare(b.id),
  );
  const n = Math.max(1, ordered.length);
  const placed = ordered.map((cell, i) => {
    const jitterA = (hash01(cell.id, 1) - 0.5) * 0.9;
    const jitterR = (hash01(cell.id, 2) - 0.5) * 0.3;
    const angle = i * GOLDEN_ANGLE + jitterA;
    const radial = spread * (Math.sqrt((i + 0.6) / n) + jitterR);
    return {
      id: cell.id,
      x: cx + Math.cos(angle) * radial * 1.55,
      y: cy + Math.sin(angle) * radial * 0.72,
      r: rMin + (rMax - rMin) * Math.pow(cell.sizeScore, 0.9),
    };
  });
  const clearance = new Map<string, number>();
  for (const cell of cells) {
    if (cell.attention) clearance.set(cell.id, 9);
    else if (cell.labelVisible) clearance.set(cell.id, 7);
  }
  separateCells(placed, clearance, bounds);
  return placed;
}

function nodePoint(
  ref: KineticNodeRef,
  L: Pick<KineticStage, "anchors" | "orchestrators" | "edges" | "strata" | "storageTop" | "w" | "anchorY">,
  /** Where along a stratum's top edge a flow lands (0..1 of its width). */
  poolAlong = 0.5,
): Pt {
  switch (ref.kind) {
    case "edge": {
      const edge = L.edges.find((e) => e.id === ref.id)!;
      return { x: edge.x + (edge.side === "left" ? 12 : -12), y: edge.y };
    }
    case "anchor": {
      const anchor = L.anchors.find((a) => a.id === ref.id)!;
      return { x: anchor.x, y: anchor.y };
    }
    case "orchestrator": {
      const orc = L.orchestrators.find((o) => o.id === ref.id)!;
      return { x: orc.x, y: orc.y + 22 };
    }
    case "pool": {
      const stratum = L.strata.find((s) => s.name === ref.name);
      if (stratum) return { x: stratum.x + stratum.w * poolAlong, y: stratum.y };
      return { x: L.w / 2, y: L.storageTop - 18 };
    }
    case "storage":
      return { x: L.w / 2, y: L.storageTop - 18 };
  }
}

/**
 * Shape a flow path between two resolved points. Control points depend on the
 * connection archetype so horizontal runs glide and storage drops fall in a
 * slow S; the import bridge arcs above the storage floor.
 */
function flowPath(flow: KineticFlow, from: Pt, to: Pt, L: KineticStage): SampledPath {
  const anchorDrop = 58; // ribbons connect below the anchor typography
  if (flow.kind === "wan-transfer" || flow.kind === "egress") {
    const a = { ...from };
    const b = { ...to };
    // Land at the edge of the anchor's glow pool, not on the wordmark, and
    // stop short of the edge labels.
    if (flow.kind === "wan-transfer") {
      a.x += 34; // clear the WAN wordmark
      b.x -= 92;
    }
    if (flow.kind === "egress") {
      a.x += 92;
      b.x -= 42; // stop short of the client edge labels
    }
    const dx = b.x - a.x;
    return samplePath(
      a,
      { x: a.x + dx * 0.35, y: a.y - L.h * 0.022 },
      { x: b.x - dx * 0.35, y: b.y + L.h * 0.008 },
      b,
    );
  }
  if (flow.kind === "import-copy") {
    const lift = L.h * 0.075;
    return samplePath(
      from,
      { x: from.x + (to.x - from.x) * 0.3, y: from.y - lift },
      { x: to.x - (to.x - from.x) * 0.3, y: to.y - lift },
      to,
    );
  }
  if (flow.kind === "organize") {
    const dy = to.y - from.y;
    return samplePath(
      from,
      { x: from.x, y: from.y + dy * 0.42 },
      { x: to.x, y: to.y - dy * 0.34 },
      { x: to.x, y: to.y - 4 },
    );
  }
  // storage-transfer / playback: a slow diagonal S between anchor and stratum.
  const upper = from.y < to.y ? { ...from } : { ...to };
  const lower = from.y < to.y ? { ...to } : { ...from };
  upper.y += anchorDrop;
  const dy = lower.y - upper.y;
  const path = samplePath(
    upper,
    { x: upper.x, y: upper.y + dy * 0.34 },
    { x: lower.x, y: lower.y - dy * 0.48 },
    lower,
  );
  if (from.y < to.y) return path;
  // Keep the sampled direction aligned with flow.from → flow.to.
  const reversed = [...path.points].reverse();
  const lengths: number[] = [0];
  for (let i = 1; i < reversed.length; i++) {
    lengths.push(
      lengths[i - 1]! +
        Math.hypot(reversed[i]!.x - reversed[i - 1]!.x, reversed[i]!.y - reversed[i - 1]!.y),
    );
  }
  return { points: reversed, lengths, total: lengths[lengths.length - 1]! };
}

// --- entry ----------------------------------------------------------------------------

/**
 * Stage geometry (no flow paths). Deterministic, and dependent ONLY on the
 * inputs in `stageGeometryKey` plus each cell's sizeScore at build time —
 * callers cache it against the key so telemetry updates can never move the
 * composition.
 */
export function buildKineticStage(scene: KineticScene, w: number, h: number): KineticStage {
  const bandH = Math.min(Math.max(h * 0.088, 64), 108);
  const stageH = h - bandH;
  const orchY = bandH + stageH * 0.135;
  const anchorY = bandH + stageH * 0.34;
  // The pool name + capacity block below each stratum needs real pixels, not
  // a fraction: at small stage heights (200% zoom) a pure-percentage floor
  // clipped the capacity line off the bottom of the viewport.
  const storageH = Math.min(Math.max(h * 0.078, 34), 84);
  const storageTop = h - storageH - Math.max(h * 0.087, 62);

  const anchors: AnchorPlacement[] = [
    { id: "qbittorrent", x: w * 0.335, y: anchorY, r: Math.min(w, h * 1.6) * 0.085 },
    { id: "jellyfin", x: w * 0.665, y: anchorY, r: Math.min(w, h * 1.6) * 0.085 },
  ];
  const orchestrators: OrchestratorPlacement[] = [
    { id: "seerr", x: w * 0.4, y: orchY },
    { id: "sonarr", x: w * 0.5, y: orchY },
    { id: "radarr", x: w * 0.6, y: orchY },
  ];
  const edges: EdgePlacement[] = [
    { id: "wan", x: w * 0.048, y: anchorY, side: "left" },
    { id: "clients", x: w * 0.952, y: anchorY, side: "right" },
  ];

  // Storage floor: widths weighted by log capacity, download → media → other.
  const spanX = w * 0.1;
  const spanW = w * 0.8;
  const gap = Math.max(14, w * 0.012);
  const weights = scene.storage.map((s) =>
    Math.max(2, Math.log2(Math.max(1, s.totalBytes / 1e12) + 1)),
  );
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  const usable = spanW - gap * Math.max(0, scene.storage.length - 1);
  let cursor = spanX;
  const strata: StratumPlacement[] = scene.storage.map((s, i) => {
    const sw = usable * (weights[i]! / weightSum);
    const rect = { name: s.name, x: cursor, y: storageTop, w: sw, h: storageH };
    cursor += sw + gap;
    return rect;
  });

  // Workload field: clusters spread between the anchors band and the floor.
  const fieldTop = bandH + stageH * 0.5;
  const fieldBottom = storageTop - h * 0.085;
  const fieldCy = (fieldTop + fieldBottom) / 2;
  const totalCells = scene.field.reduce((acc, g) => acc + g.cells.length, 0) || 1;
  const groupWeights = scene.field.map((g) => Math.sqrt(g.cells.length / totalCells));
  const groupWeightSum = groupWeights.reduce((a, b) => a + b, 0) || 1;
  const fieldSpanX = w * 0.14;
  const fieldSpanW = w * 0.72;
  let gCursor = fieldSpanX;
  const rMin = Math.max(3, h * 0.0042);
  const rMax = Math.max(9, h * 0.0125);
  const groups: GroupPlacement[] = scene.field.map((group, i) => {
    const gw = fieldSpanW * (groupWeights[i]! / groupWeightSum);
    const cx = gCursor + gw / 2;
    const groupLeft = gCursor;
    gCursor += gw;
    // Spread scales with population so dense clusters loosen instead of
    // clumping; the caption hangs just under the cluster's own extent.
    const spread = Math.min(
      Math.max(Math.sqrt(group.cells.length) * rMax * 1.7, gw * 0.14),
      gw * 0.42,
    );
    const cy = fieldCy + (hash01(group.id, 3) - 0.5) * h * 0.016;
    const labelY = Math.min(cy + spread * 0.78 + 26, storageTop - h * 0.032);
    return {
      id: group.id,
      label: group.label,
      cx,
      cy,
      labelY,
      // Territory clamp: a group's cells stay inside its own span (with a
      // small margin so adjacent groups keep visible separation) and above
      // the caption row so a relaxed cell can never sit on the group label.
      cells: placeCells(group.cells, cx, cy, spread, rMin, rMax, {
        minX: groupLeft + 3,
        maxX: groupLeft + gw - 3,
        minY: fieldTop - h * 0.04,
        maxY: labelY - 14,
      }),
    };
  });

  return {
    w,
    h,
    bandH,
    orchY,
    anchorY,
    anchors,
    orchestrators,
    edges,
    groups,
    strata,
    storageTop,
    cellRMin: rMin,
    cellRMax: rMax,
  };
}

/**
 * Flow paths over a fixed stage. Cheap to recompute when the flow SET
 * changes; endpoint geometry comes from the cached stage, so a new flow can
 * never move anchors, cells, or strata.
 */
export function buildFlowPaths(
  flows: readonly KineticFlow[],
  stage: KineticStage,
): FlowPlacement[] {
  return flows.map((flow) => {
    // Flow landings on strata are biased toward whatever they connect to so
    // ribbons travel less: the import bridge spans the gap between strata
    // shoulder-to-shoulder (clear of the download drop), the download drop
    // lands on the pool's near shoulder, playback leaves from the shoulder
    // facing Jellyfin.
    const fromAlong =
      flow.kind === "import-copy" ? 0.74 : flow.kind === "playback" ? 0.72 : 0.5;
    const toAlong =
      flow.kind === "import-copy"
        ? 0.26
        : flow.kind === "storage-transfer"
          ? 0.62
          : 0.5;
    const from = nodePoint(flow.from, stage, fromAlong);
    const to = nodePoint(flow.to, stage, toAlong);
    return {
      id: flow.id,
      path: flowPath(flow, from, to, stage),
    };
  });
}

/** Full layout: cached-stage geometry plus paths for the current flow set. */
export function buildKineticLayout(scene: KineticScene, w: number, h: number): KineticLayout {
  const stage = buildKineticStage(scene, w, h);
  return { ...stage, flows: buildFlowPaths(scene.flows, stage) };
}
