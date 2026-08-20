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
  slot: number;
}

export interface GroupPlacement {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  labelY: number;
  overflowCount: number;
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

export const FIELD_GROUP_CAPACITY = 24;
export const FIELD_MAX_RENDERED_CELLS = FIELD_GROUP_CAPACITY * 4;
const FIELD_GROUP_COLUMNS = 4;
const FIELD_SLOT_COLUMNS = 6;
const FIELD_SLOT_ROWS = 4;
const GROUP_SLOT_INDEX = new Map<string, number>([
  ["group:platform", 0],
  ["group:media-support", 1],
  ["group:observability", 2],
  ["group:network-edge", 3],
]);

interface GroupBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function placeCells(
  cells: FieldCellModel[],
  bounds: GroupBounds,
  rMin: number,
  rMax: number,
): { cells: CellPlacement[]; overflowCount: number } {
  const insetX = Math.max(8, bounds.w * 0.045);
  const insetTop = 8;
  const insetBottom = 8;
  const usableW = Math.max(bounds.w - insetX * 2, 1);
  const usableH = Math.max(bounds.h - insetTop - insetBottom, 1);
  const pitchX = usableW / FIELD_SLOT_COLUMNS;
  const pitchY = usableH / FIELD_SLOT_ROWS;
  const slot = Math.max(Math.min(pitchX, pitchY) - 4, 16);
  const visible = cells.slice(0, FIELD_GROUP_CAPACITY);
  return {
    overflowCount: Math.max(0, cells.length - FIELD_GROUP_CAPACITY),
    cells: visible.map((cell, index) => {
      const row = Math.floor(index / FIELD_SLOT_COLUMNS);
      const col = index % FIELD_SLOT_COLUMNS;
      return {
        id: cell.id,
        x: bounds.x + insetX + pitchX * (col + 0.5),
        y: bounds.y + insetTop + pitchY * (row + 0.5),
        r: rMin + (rMax - rMin) * Math.pow(cell.sizeScore, 0.9),
        slot,
      };
    }),
  };
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
  if (flow.kind === "import-copy" || flow.kind === "background-transfer") {
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
 * inputs in `stageGeometryKey` — callers cache it against the key so
 * telemetry updates can never move the composition.
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

  // Workload field: four reserved group lanes, each with its own deterministic
  // row-major slot grid. Telemetry changes resize the rounded square inside a
  // slot, but never repack or reorder the field.
  const fieldTop = bandH + stageH * 0.5;
  const labelY = storageTop - Math.max(h * 0.03, 22);
  const groupTop = fieldTop;
  const groupH = Math.max(labelY - 18 - groupTop, 1);
  const fieldSpanX = w * 0.1;
  const fieldSpanW = w * 0.8;
  const groupGap = Math.max(12, w * 0.01);
  const groupW = Math.max(
    (fieldSpanW - groupGap * (FIELD_GROUP_COLUMNS - 1)) / FIELD_GROUP_COLUMNS,
    1,
  );
  const slotExtent = Math.min(
    (groupW - Math.max(8, groupW * 0.045) * 2) / FIELD_SLOT_COLUMNS,
    (groupH - 16) / FIELD_SLOT_ROWS,
  );
  const rMax = Math.max(8, Math.min(slotExtent * 0.38, h * 0.0135));
  const rMin = Math.max(4, Math.min(rMax - 2, slotExtent * 0.22));
  const groups: GroupPlacement[] = scene.field.map((group, index) => {
    const slotIndex = GROUP_SLOT_INDEX.get(group.id) ?? Math.min(index, FIELD_GROUP_COLUMNS - 1);
    const x = fieldSpanX + slotIndex * (groupW + groupGap);
    const y = groupTop;
    const bounds = { x, y, w: groupW, h: groupH };
    const placed = placeCells(group.cells, bounds, rMin, rMax);
    return {
      id: group.id,
      label: group.label,
      x,
      y,
      w: groupW,
      h: groupH,
      cx: x + groupW / 2,
      cy: y + groupH / 2,
      labelY,
      overflowCount: placed.overflowCount,
      cells: placed.cells,
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
    const poolBridge =
      (flow.kind === "import-copy" || flow.kind === "background-transfer") &&
      flow.from.kind === "pool" &&
      flow.to.kind === "pool";
    const sourcePoolName = flow.from.kind === "pool" ? flow.from.name : null;
    const destinationPoolName = flow.to.kind === "pool" ? flow.to.name : null;
    const sourceStratum = sourcePoolName
      ? stage.strata.find((stratum) => stratum.name === sourcePoolName)
      : undefined;
    const destinationStratum = destinationPoolName
      ? stage.strata.find((stratum) => stratum.name === destinationPoolName)
      : undefined;
    const sourceLeftOfDestination =
      sourceStratum && destinationStratum
        ? sourceStratum.x + sourceStratum.w / 2 <
          destinationStratum.x + destinationStratum.w / 2
        : true;
    const fromAlong = poolBridge
      ? sourceLeftOfDestination
        ? 0.74
        : 0.26
      : flow.kind === "playback"
        ? 0.72
        : 0.5;
    const toAlong = poolBridge
      ? sourceLeftOfDestination
        ? 0.26
        : 0.74
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
