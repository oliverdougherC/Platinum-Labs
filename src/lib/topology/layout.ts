/**
 * Living-topology layout (PLA-266) — pure geometry, no React.
 *
 * The composition lives in a fixed 1600×900 abstract space (both target
 * monitors are 16:9; the SVG scales with `preserveAspectRatio="xMidYMid
 * meet"`). Positions are deliberate, not algorithmic: this is one designed
 * composition, not a force-directed graph.
 *
 *   network edge   service orbit      compute core       storage bodies
 *   (left rim)     Jellyfin/arr/qb    32 CPU spokes +    DataStore / NVMe /
 *                  /Seerr nodes       memory halo        eSATA
 */

export const CANVAS_W = 1600;
export const CANVAS_H = 900;

export interface Point {
  x: number;
  y: number;
}

export const CORE_CENTER: Point = { x: 790, y: 425 };
/** Inner radius where CPU spokes start. */
export const CORE_INNER_R = 74;
/** Max spoke length at 100% utilization. */
export const CORE_SPOKE_MAX = 84;
/** Memory halo radius band. */
export const HALO_R = 196;

/** The network boundary: a vertical rim segment on the left edge. */
export const NETWORK_EDGE = { x: 148, yTop: 250, yBottom: 650 };

export type ServiceId = "jellyfin" | "sonarr" | "radarr" | "qbittorrent" | "seerr";

export interface ServiceNodeLayout {
  id: ServiceId;
  label: string;
  center: Point;
  r: number;
}

export const SERVICE_NODES: ServiceNodeLayout[] = [
  { id: "jellyfin", label: "Jellyfin", center: { x: 468, y: 246 }, r: 30 },
  { id: "seerr", label: "Requests", center: { x: 356, y: 348 }, r: 20 },
  { id: "sonarr", label: "Sonarr", center: { x: 330, y: 470 }, r: 24 },
  { id: "radarr", label: "Radarr", center: { x: 356, y: 592 }, r: 24 },
  { id: "qbittorrent", label: "qBittorrent", center: { x: 468, y: 692 }, r: 26 },
];

/** Cluster anchor for secondary (unlabeled) Docker container points. */
export const CONTAINER_CLUSTER: Point = { x: 258, y: 800 };

export interface StorageBodyLayout {
  name: string;
  center: Point;
  r: number;
}

/**
 * Storage bodies. Radii loosely follow logical capacity (DataStore 69.6 TB ≫
 * eSATA 27.7 TB ≫ NVMe 1.9 TB) without literal proportionality — legibility
 * beats literal scale (spec §5).
 */
export const STORAGE_BODIES: StorageBodyLayout[] = [
  { name: "DataStore", center: { x: 1235, y: 425 }, r: 108 },
  // NVMe and eSATA bracket DataStore on the outer edge, clear of the playback
  // (top) and import (bottom) flow corridors.
  { name: "NVME", center: { x: 1424, y: 196 }, r: 46 },
  { name: "eSATA", center: { x: 1424, y: 662 }, r: 70 },
];

/** Fallback placement for pools the layout doesn't know by name. */
export function storageBodyFor(name: string, index: number): StorageBodyLayout {
  const known = STORAGE_BODIES.find((b) => b.name === name);
  if (known) return known;
  return {
    name,
    center: { x: 1420, y: 200 + (index % 4) * 160 },
    r: 44,
  };
}

export type FlowId =
  | "ingress-qbittorrent"
  | "qbittorrent-sonarr"
  | "qbittorrent-radarr"
  | "import-datastore"
  | "storage-jellyfin"
  | "jellyfin-egress";

/** Cubic bezier path string between two points with a horizontal bow. */
function bez(a: Point, b: Point, bow = 0.35): string {
  const dx = b.x - a.x;
  const c1 = { x: a.x + dx * bow, y: a.y };
  const c2 = { x: b.x - dx * bow, y: b.y };
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
}

function serviceCenter(id: ServiceId): Point {
  return SERVICE_NODES.find((s) => s.id === id)!.center;
}

/**
 * Flow path geometry. Paths route between real endpoints; the import path's
 * target is parameterized by pool name so imports animate into the pool that
 * is actually being written.
 */
export function flowPath(id: FlowId, targetPool?: string): string {
  const qb = serviceCenter("qbittorrent");
  const jf = serviceCenter("jellyfin");
  switch (id) {
    case "ingress-qbittorrent":
      return bez({ x: NETWORK_EDGE.x, y: NETWORK_EDGE.yBottom - 30 }, qb);
    case "qbittorrent-sonarr":
      return bez(qb, serviceCenter("sonarr"), 0.5);
    case "qbittorrent-radarr":
      return bez(qb, serviceCenter("radarr"), 0.5);
    case "import-datastore": {
      const body = STORAGE_BODIES.find((b) => b.name === targetPool) ?? STORAGE_BODIES[0]!;
      // Route imports beneath the compute core: downloader side → pool.
      const mid: Point = { x: CORE_CENTER.x, y: CORE_CENTER.y + HALO_R + 88 };
      const from = { x: qb.x + 40, y: qb.y - 10 };
      const to = { x: body.center.x - body.r * 0.55, y: body.center.y + body.r * 0.7 };
      return `M ${from.x} ${from.y} C ${mid.x - 220} ${mid.y}, ${mid.x + 160} ${mid.y}, ${to.x} ${to.y}`;
    }
    case "storage-jellyfin": {
      const body = STORAGE_BODIES.find((b) => b.name === targetPool) ?? STORAGE_BODIES[0]!;
      const from = { x: body.center.x - body.r * 0.6, y: body.center.y - body.r * 0.65 };
      // Route playback above the compute core: pool → Jellyfin.
      const mid: Point = { x: CORE_CENTER.x, y: CORE_CENTER.y - HALO_R - 74 };
      return `M ${from.x} ${from.y} C ${mid.x + 180} ${mid.y}, ${mid.x - 200} ${mid.y}, ${jf.x + 24} ${jf.y - 8}`;
    }
    case "jellyfin-egress":
      return bez(jf, { x: NETWORK_EDGE.x, y: NETWORK_EDGE.yTop + 30 });
  }
}

/** Spoke geometry for one logical CPU. Angles start at 12 o'clock, clockwise. */
export function spokeAngle(core: number, coreCount: number): number {
  return (core / coreCount) * Math.PI * 2 - Math.PI / 2;
}

export function pointOnCircle(center: Point, r: number, angle: number): Point {
  return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
}

/** Arc path (SVG) for a fraction of a circle starting at 12 o'clock. */
export function arcPath(
  center: Point,
  r: number,
  fraction: number,
  clockwise = true,
): string {
  const f = Math.max(0, Math.min(fraction, 0.99999));
  if (f <= 0) return "";
  const start = -Math.PI / 2;
  const end = start + (clockwise ? 1 : -1) * f * Math.PI * 2;
  const a = pointOnCircle(center, r, start);
  const b = pointOnCircle(center, r, end);
  const large = f > 0.5 ? 1 : 0;
  const sweep = clockwise ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} ${sweep} ${b.x} ${b.y}`;
}
