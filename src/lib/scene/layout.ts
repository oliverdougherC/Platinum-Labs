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
 *   network arc   (radius NETWORK_R)         … system boundary, left rim
 *   storage bodies                           … outer massive bodies, right
 *
 * World units: height is fixed at 1000; width = 1000 × aspect. Every position
 * derives from the world size and the model — same model + same aspect ⇒
 * identical layout (screenshot review depends on this).
 */

import { pointOnCircle, vec, type Vec } from "@/lib/scene/geom";
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

export interface SceneLayout {
  world: { w: number; h: number };
  core: CoreGeom;
  services: Map<ServiceId, BodyGeom>;
  storage: Map<string, BodyGeom>;
  /** Present when flows target generic storage (no declared media pool). */
  genericStorage: BodyGeom | null;
  networkArc: ArcGeom;
  dockerBelt: ArcGeom;
  /** The one routing-lane radius all core-passing flows arc along. */
  laneR: number;
  serviceOrbitR: number;
  /** Margins inside which all bodies + labels must stay. */
  safe: { top: number; right: number; bottom: number; left: number };
}

export const SERVICE_ORBIT_R = 296;
export const LANE_R = 372;
export const BELT_R = 452;

/** Orbital positions (canvas angles: 0 = east, positive = down/clockwise). */
const SERVICE_ANGLES: Record<ServiceId, number> = {
  jellyfin: deg(-108),
  seerr: deg(-149),
  sonarr: deg(172),
  radarr: deg(136),
  qbittorrent: deg(102),
};

const SERVICE_RADII: Record<ServiceId, number> = {
  jellyfin: 30, // playback is high-value — slightly more prominent
  seerr: 15, // quiet
  sonarr: 21,
  radarr: 21, // sibling of sonarr
  qbittorrent: 25, // denser, utilitarian
};

/** Storage body sizes by semantic rank (largest first). Not literal capacity. */
const STORAGE_RADII = [112, 66, 44];

export function computeLayout(model: SceneModel, aspect: number): SceneLayout {
  const h = WORLD_H;
  const w = Math.max(h * 1.3, h * aspect);
  const safe = { top: 26, right: 30, bottom: 26, left: 30 };

  // The star sits left of frame center so storage mass balances the right.
  const core: CoreGeom = {
    center: vec(w * 0.408, h * 0.52),
    discR: 30,
    spokeBaseR: 62,
    spokeMaxLen: 44,
    memR: 138,
    memBandW: 18,
    boundaryR: 176,
    atmosphereR: 216,
  };

  const services = new Map<ServiceId, BodyGeom>();
  for (const s of model.services) {
    const angle = SERVICE_ANGLES[s.id];
    const r = SERVICE_RADII[s.id];
    const center = pointOnCircle(core.center, SERVICE_ORBIT_R, angle);
    services.set(s.id, {
      id: `service:${s.id}`,
      center,
      r,
      atmosphereR: r + 8,
      orbitAngle: angle,
      // Labels sit outside the orbit, along the radial direction, so they
      // never collide with the orbit guide or the lane.
      labelAnchor: pointOnCircle(core.center, SERVICE_ORBIT_R + r + 34, angle),
    });
  }

  // Storage: rank 0 anchors the right side at core height; smaller bodies
  // bracket it high/low, clear of the (top) playback and (bottom) import lanes.
  const storageAnchors: Array<{ at: Vec; r: number }> = [
    { at: vec(w * 0.762, h * 0.462), r: STORAGE_RADII[0]! },
    { at: vec(w * 0.884, h * 0.772), r: STORAGE_RADII[1]! },
    { at: vec(w * 0.878, h * 0.176), r: STORAGE_RADII[2]! },
  ];
  const storage = new Map<string, BodyGeom>();
  const byRank = [...model.storage].sort((a, b) => a.rank - b.rank);
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

  // Generic storage endpoint (no declared media pool): a deliberately
  // understated marker between the core and the storage group.
  const genericStorage: BodyGeom | null = model.genericStorageTarget
    ? {
        id: "storage:generic",
        center: vec(w * 0.66, h * 0.66),
        r: 26,
        atmosphereR: 34,
        orbitAngle: null,
        labelAnchor: vec(w * 0.66, h * 0.66 + 52),
      }
    : null;

  // Network boundary: a large arc concentric with the core, left rim.
  // Swept from a0 to a1 through the left (angle 180°) — the heliopause.
  const networkArc: ArcGeom = {
    center: core.center,
    r: Math.min(core.center.x - safe.left - 18, 560),
    a0: deg(118),
    a1: deg(242),
  };

  const dockerBelt: ArcGeom = {
    center: core.center,
    r: BELT_R,
    a0: deg(108),
    a1: deg(140),
  };

  return {
    world: { w, h },
    core,
    services,
    storage,
    genericStorage,
    networkArc,
    dockerBelt,
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
