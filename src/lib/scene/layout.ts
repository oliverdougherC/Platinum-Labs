/**
 * Scene layout engine (PLA-266 rebuild) — deterministic world geometry.
 *
 * One celestial system, one set of concentric relationships:
 *
 *   central star (compute + memory)          … the hero object
 *   service orbit (radius SERVICE_ORBIT_R)   … inner orbital system, left
 *   routing lane  (radius LANE_R)            … invisible circle all long
 *                                              flows travel along
 *   docker belt   (radius BELT_R)            … asteroid field, lower left
 *   network arc   (radius NETWORK_R)         … system boundary, left rim,
 *                                              with ONE gateway aperture all
 *                                              WAN traffic passes through
 *   storage bodies                           … outer massive bodies, right
 *
 * The service crescent is placed to tell the semantic story (PLA-266 v2):
 * qBittorrent sits nearest the network gateway on the inbound lane;
 * Sonarr/Radarr sit low, as controllers between acquisition and the
 * bottom-hemisphere import lane toward storage; Jellyfin sits high on the
 * top-hemisphere playback path between storage and the network; Requests
 * stays small and out of the data lanes.
 *
 * World units: height is fixed at 1000; width = 1000 × aspect. Every position
 * derives from the world size and the model — same model + same aspect ⇒
 * identical layout (screenshot review depends on this).
 */

import { dist, pointOnCircle, vec, type Vec } from "@/lib/scene/geom";
import type { SceneModel, ServiceId } from "@/lib/scene/model";

export const WORLD_H = 1000;

/** Degrees → radians, for readable angle tables. */
const deg = (d: number) => (d * Math.PI) / 180;

export interface BodyGeom {
  /** Stable body id: "core", "service:jellyfin", "pool:DataStore", "storage:generic". */
  id: string;
  center: Vec;
  /** Hard body radius: connections terminate on this circle (+ padding). */
  r: number;
  /** Outer decorative radius (atmosphere/rings) — clearance checks use this. */
  atmosphereR: number;
  /** Angle of the body as seen from the core (its orbital position), if orbital. */
  orbitAngle: number | null;
  labelAnchor: Vec;
}

export interface CoreGeom {
  center: Vec;
  /** Inner luminous disc. */
  discR: number;
  /** Radius the CPU corona filaments grow from. */
  spokeBaseR: number;
  /** Max filament length at 100% utilization. */
  spokeMaxLen: number;
  /** Memory halo band (dust torus) inner radius / band width. */
  memR: number;
  memBandW: number;
  /** Routing boundary: no flow may come nearer to the core than this. */
  boundaryR: number;
  atmosphereR: number;
}

export interface ArcGeom {
  center: Vec;
  r: number;
  /** Start/end angles (radians); the drawn portion of the circle. */
  a0: number;
  a1: number;
}

/** The single aperture where WAN traffic enters/leaves the system boundary. */
export interface GatewayGeom {
  /** Angle on the network arc. */
  angle: number;
  /** Point on the arc — every network flow terminates here. */
  point: Vec;
}

export interface SceneLayout {
  world: { w: number; h: number };
  core: CoreGeom;
  services: Map<ServiceId, BodyGeom>;
  storage: Map<string, BodyGeom>;
  /** Present when flows target generic storage (no declared media pool). */
  genericStorage: BodyGeom | null;
  networkArc: ArcGeom;
  gateway: GatewayGeom;
  dockerBelt: ArcGeom;
  containerField: Map<string, BodyGeom>;
  containerOverflow: BodyGeom | null;
  containerOverflowCount: number;
  containerCaption: Vec;
  /** The one routing-lane radius all core-passing flows arc along. */
  laneR: number;
  serviceOrbitR: number;
  /** Margins inside which all bodies + labels must stay. */
  safe: { top: number; right: number; bottom: number; left: number };
}

/**
 * Concentric radii (PLA-266 v2 rebalance): the compute star grew ~28% so it
 * reads as the hero from across the room, and every ring stepped outward with
 * it. The service crescent grew more than the star (small bodies were the
 * bigger legibility problem at 1080p).
 */
export const SERVICE_ORBIT_R = 344;
export const LANE_R = 424;
export const BELT_R = 456;
export const MAX_RENDERED_CONTAINERS = 96;

/**
 * Fixed reserved envelope for every container slot (world units): the maximum
 * drawn body radius (13, see containerRadius) plus breathing margin. Layout
 * reserves this NOMINAL envelope instead of the live radius, so a container's
 * CENTER depends only on stable identity, viewport/aspect, and stable
 * topology membership — CPU/memory/I/O/health changes let the drawn body
 * breathe INSIDE its slot without moving it or repositioning neighbours.
 * I/O halos are decorative atmosphere and never become layout obstacles.
 */
export const CONTAINER_SLOT_R = 18;

/**
 * Which containers get a rendered body when the population exceeds the
 * visual budget. NEVER the first `max` alphabetically: attention-worthy,
 * unknown, and active containers must not vanish into the overflow.
 * Priority order:
 *   1. unhealthy / stopped / dead / restarting (`bad`)
 *   2. unknown / unverified STATE
 *   3. unavailable metric coverage (stats skipped — runtime work UNKNOWN)
 *   4. partial metric coverage (some metrics unobserved)
 *   5. highest live CPU/I/O work (never memory residency)
 *   6. deterministic name tie-breaker
 * A known-idle container must never displace one whose runtime stats are
 * unknown: unknown could be hiding real work, proven-idle cannot (tiers 3–4
 * above tier 5). Populations at or under the budget render in full; the
 * overflow body keeps a truthful count and the drawer lists every container.
 *
 * Note: tiers follow LIVE workloads and coverage, so membership near the
 * budget boundary may change as work or coverage shifts — accepted, because
 * hiding a hot or unknown container would be the greater lie. Within one
 * selected membership set, positions stay fixed.
 */
export function selectRenderedContainers<
  T extends {
    name: string;
    bad: boolean;
    unverified: boolean;
    metricCoverage: "complete" | "partial" | "unavailable";
    workScore: number;
  },
>(containers: readonly T[], max: number): T[] {
  const tier = (c: T) =>
    c.bad
      ? 0
      : c.unverified
        ? 1
        : c.metricCoverage === "unavailable"
          ? 2
          : c.metricCoverage === "partial"
            ? 3
            : 4;
  return [...containers]
    .sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      if (a.workScore !== b.workScore) return b.workScore - a.workScore;
      return a.name.localeCompare(b.name);
    })
    .slice(0, max);
}

/** Stable FNV-1a hash used only for deterministic procedural layout. */
export function containerHash(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Orbital positions (canvas angles: 0 = east, positive = down/clockwise). */
const SERVICE_ANGLES: Record<ServiceId, number> = {
  jellyfin: deg(-96), // top: on the playback path storage → jellyfin → WAN
  seerr: deg(-138), // upper-left: quiet, out of the data lanes
  sonarr: deg(118), // low: controllers between acquisition and import lane
  radarr: deg(87),
  qbittorrent: deg(154), // nearest the gateway: first hop of inbound data
};

const SERVICE_RADII: Record<ServiceId, number> = {
  jellyfin: 46, // playback is the most user-facing service — most prominent
  seerr: 18, // deliberately small and quiet
  sonarr: 31,
  radarr: 31, // sibling of sonarr
  qbittorrent: 38, // second most prominent: the acquisition workhorse
};

/** Storage body sizes by semantic rank (largest first). Not literal capacity. */
const STORAGE_RADII = [118, 70, 50];

/** Where the WAN aperture sits on the boundary arc. */
const GATEWAY_ANGLE = deg(178);

export function computeLayout(model: SceneModel, aspect: number): SceneLayout {
  const h = WORLD_H;
  const w = Math.max(h * 1.3, h * aspect);
  const safe = { top: 26, right: 30, bottom: 26, left: 30 };

  // The star sits left of frame center so storage mass balances the right.
  const core: CoreGeom = {
    center: vec(w * 0.408, h * 0.52),
    discR: 38,
    spokeBaseR: 78,
    spokeMaxLen: 56,
    memR: 172,
    memBandW: 22,
    boundaryR: 218,
    atmosphereR: 268,
  };

  const services = new Map<ServiceId, BodyGeom>();
  for (const s of model.services) {
    const angle = SERVICE_ANGLES[s.id];
    const r = SERVICE_RADII[s.id];
    const center = pointOnCircle(core.center, SERVICE_ORBIT_R, angle);
    // Label placement: upper-hemisphere services label radially outward (the
    // space is clear). Lower-hemisphere services must NOT label radially —
    // that corridor belongs to the bottom transport lane — so Sonarr/Radarr
    // hang their labels beside the body (outward-facing side), clear of both
    // the control lane and the acquisition tunnel.
    const lower = Math.sin(angle) > 0.5;
    const labelAnchor = lower
      ? vec(
          center.x + Math.sign(Math.cos(angle) || 1) * (r + 58),
          center.y - 12,
        )
      : pointOnCircle(core.center, SERVICE_ORBIT_R + r + 36, angle);
    services.set(s.id, {
      id: `service:${s.id}`,
      center,
      r,
      atmosphereR: r + 9,
      orbitAngle: angle,
      labelAnchor,
    });
  }

  // Storage: rank 0 anchors the right side at core height; smaller bodies
  // bracket it high/low, clear of the (top) playback and (bottom) import
  // lanes. The declared DOWNLOAD pool takes the bottom-right anchor
  // regardless of size rank — downloads arrive on the bottom lane, so the
  // staging pool belongs on the acquisition side, with the import copy
  // hopping up to the library from there.
  const storageAnchors: Array<{ at: Vec; r: number }> = [
    { at: vec(w * 0.762, h * 0.462), r: STORAGE_RADII[0]! },
    { at: vec(w * 0.884, h * 0.772), r: STORAGE_RADII[1]! },
    { at: vec(w * 0.878, h * 0.176), r: STORAGE_RADII[2]! },
  ];
  const storage = new Map<string, BodyGeom>();
  const byRank = [...model.storage].sort((a, b) => a.rank - b.rank);
  const downloadIdx = byRank.findIndex(
    (p, i) => i > 0 && i <= 2 && p.name === model.downloadPoolName,
  );
  if (downloadIdx === 2 && byRank.length > 2) {
    // Swap the download pool into the bottom-right (acquisition-side) anchor.
    const tmp = byRank[1]!;
    byRank[1] = byRank[2]!;
    byRank[2] = tmp;
  }
  byRank.forEach((pool, i) => {
    const anchor =
      storageAnchors[i] ??
      // Overflow pools: a quiet column along the right edge, still in-frame
      // (clamped so absurd pool counts stack rather than leave the world).
      {
        at: vec(
          w * 0.952,
          h * Math.min(0.86, 0.24 + 0.155 * (i - storageAnchors.length)),
        ),
        r: 30,
      };
    storage.set(pool.name, {
      id: `pool:${pool.name}`,
      center: anchor.at,
      r: anchor.r,
      atmosphereR: anchor.r * 1.24 + 6,
      orbitAngle: null,
      labelAnchor: vec(anchor.at.x, anchor.at.y + anchor.r * 1.24 + 30),
    });
  });

  // Generic storage endpoint (no declared media/download pool): a deliberately
  // understated marker between the core and the storage group.
  const genericStorage: BodyGeom | null = model.genericStorageTarget
    ? {
        id: "storage:generic",
        center: vec(w * 0.68, h * 0.68),
        r: 26,
        atmosphereR: 34,
        orbitAngle: null,
        labelAnchor: vec(w * 0.68, h * 0.68 + 52),
      }
    : null;

  // Network boundary: a large arc concentric with the core, left rim — the
  // heliopause. Trimmed sweep (dead weight was a review finding), with one
  // gateway aperture that every WAN conduit passes through.
  const networkArc: ArcGeom = {
    center: core.center,
    r: Math.min(core.center.x - safe.left - 18, 560),
    a0: deg(124),
    a1: deg(236),
  };
  const gateway: GatewayGeom = {
    angle: GATEWAY_ANGLE,
    point: pointOnCircle(networkArc.center, networkArc.r, GATEWAY_ANGLE),
  };

  const dockerBelt: ArcGeom = {
    center: core.center,
    r: BELT_R,
    a0: deg(18),
    a1: deg(162),
  };

  // Above the visual budget, keep the attention-worthy and active containers
  // (never the first N alphabetically); see selectRenderedContainers.
  const renderedContainers = selectRenderedContainers(
    model.docker.containers,
    MAX_RENDERED_CONTAINERS,
  );
  const containerOverflowCount = Math.max(
    0,
    model.docker.containers.length - renderedContainers.length,
  );
  const containerField = new Map<string, BodyGeom>();
  const fixedObstacles: BodyGeom[] = [
    ...services.values(),
    ...storage.values(),
    ...(genericStorage ? [genericStorage] : []),
  ];
  const placed: BodyGeom[] = [];
  const span = dockerBelt.a1 - dockerBelt.a0;
  const unit = 1 / 0x1_0000_0000;

  // Placement is a pure function of (name, aspect, membership set): every
  // slot reserves the fixed CONTAINER_SLOT_R envelope, never the live radius
  // or I/O halo, so telemetry changes cannot move any center. Placement order
  // is name-sorted so telemetry ORDER cannot either. Adding/removing a
  // container (or membership churn at the overflow boundary) may shift the
  // collision-resolution of later attempts — membership is part of the stable
  // configuration; per-sample metrics are not.
  const placementOrder = [...renderedContainers].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const container of placementOrder) {
    const seed = containerHash(container.name);
    const u = seed * unit;
    const v = containerHash(`${container.name}:radius`) * unit;
    let chosen: Vec | null = null;
    for (let attempt = 0; attempt < 72; attempt++) {
      const angle = dockerBelt.a0 + span * ((u + attempt * 0.61803398875) % 1);
      const desiredR = BELT_R + 58 * ((v + attempt * 0.38196601125) % 1);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const edgeR = Math.min(
        cos > 0
          ? (w - safe.right - CONTAINER_SLOT_R - core.center.x) / cos
          : (core.center.x - safe.left - CONTAINER_SLOT_R) / -cos,
        sin > 0
          ? (h - safe.bottom - CONTAINER_SLOT_R - core.center.y) / sin
          : (core.center.y - safe.top - CONTAINER_SLOT_R) / -sin,
      );
      const radius = Math.min(desiredR, edgeR);
      if (radius < core.atmosphereR + CONTAINER_SLOT_R + 38) continue;
      const point = pointOnCircle(core.center, radius, angle);
      const clear = [...fixedObstacles, ...placed].every(
        (body) => dist(point, body.center) >= body.atmosphereR + CONTAINER_SLOT_R + 12,
      );
      if (clear) {
        chosen = point;
        break;
      }
    }
    if (!chosen) {
      // Dense-population fallback stays deterministic and in-bounds. A small
      // amount of overlap is preferable to silently dropping a real object.
      const angle = dockerBelt.a0 + span * u;
      const edgeR = Math.min(
        BELT_R,
        Math.abs(Math.sin(angle)) > 0.01
          ? (h - safe.bottom - CONTAINER_SLOT_R - core.center.y) / Math.sin(angle)
          : BELT_R,
      );
      chosen = pointOnCircle(core.center, Math.max(core.atmosphereR + 64, edgeR), angle);
    }
    const geom: BodyGeom = {
      id: `container:${container.name}`,
      center: chosen,
      // The DRAWN body keeps its live radius (it breathes inside the slot);
      // the reserved obstacle envelope stays the fixed slot size.
      r: container.radius,
      atmosphereR: CONTAINER_SLOT_R,
      orbitAngle: Math.atan2(chosen.y - core.center.y, chosen.x - core.center.x),
      labelAnchor: vec(chosen.x, chosen.y + CONTAINER_SLOT_R + 13),
    };
    containerField.set(container.name, geom);
    placed.push(geom);
  }

  const containerOverflow: BodyGeom | null = containerOverflowCount > 0
    ? {
        id: "container:overflow",
        center: pointOnCircle(core.center, Math.min(BELT_R, h - core.center.y - 48), deg(52)),
        r: 16,
        atmosphereR: 22,
        orbitAngle: deg(52),
        labelAnchor: pointOnCircle(core.center, Math.min(BELT_R, h - core.center.y - 48) + 32, deg(52)),
      }
    : null;

  return {
    world: { w, h },
    core,
    services,
    storage,
    genericStorage,
    networkArc,
    gateway,
    dockerBelt,
    containerField,
    containerOverflow,
    containerOverflowCount,
    containerCaption: vec(safe.left + 92, h - safe.bottom - 56),
    laneR: LANE_R,
    serviceOrbitR: SERVICE_ORBIT_R,
    safe,
  };
}

/** Every body a flow can terminate on, keyed the way flow endpoints resolve. */
export function bodyForEndpoint(
  layout: SceneLayout,
  endpoint:
    | { kind: "network" }
    | { kind: "service"; id: Exclude<ServiceId, "seerr"> }
    | { kind: "pool"; name: string }
    | { kind: "storage" },
): BodyGeom | ArcGeom | null {
  switch (endpoint.kind) {
    case "network":
      return layout.networkArc;
    case "service":
      return layout.services.get(endpoint.id) ?? null;
    case "pool":
      return layout.storage.get(endpoint.name) ?? layout.genericStorage;
    case "storage":
      return layout.genericStorage;
  }
}
