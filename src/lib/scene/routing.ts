/**
 * Flow router (PLA-266 rebuild) — ONE curvature language for every connection.
 *
 * Rules:
 *  - a path begins and ends ON a body boundary circle (+PAD), entering and
 *    leaving along the local radial direction — never at a body center, never
 *    at an arbitrary offset;
 *  - every WAN conduit passes through the ONE gateway aperture on the network
 *    boundary arc: services radially near the gateway (qBittorrent) connect
 *    with a single blend, distant services (Jellyfin egress) ride the routing
 *    lane the short way around and exit radially at the gateway;
 *  - Arr→downloader control signals travel along the SERVICE ORBIT circle
 *    itself (inset), so the path can never clip a third service body;
 *  - long flows (organize, storage-transfer, playback) blend onto the one
 *    routing LANE circle around the core and arc along it — playback through
 *    the TOP hemisphere, acquisition/import through the BOTTOM — so long
 *    paths are recognizably siblings and never cross the compute star;
 *  - storage→storage copies (cross-pool import) blend directly between the
 *    two bodies — they never wrap the core;
 *  - every joint uses the same cubic blend primitive (geom.sampleBlend), so
 *    all transitions share one curvature character.
 *
 * Pure geometry; the renderer decides stroke/particles, tests check clearance.
 */

import {
  angleOf,
  dist,
  norm,
  pointOnCircle,
  sampleArc,
  sampleBlend,
  samplePath,
  sub,
  joinRuns,
  wrapAngle,
  type SampledPath,
  type Vec,
} from "@/lib/scene/geom";
import {
  bodyForEndpoint,
  type ArcGeom,
  type BodyGeom,
  type SceneLayout,
} from "@/lib/scene/layout";
import type { FlowObservation } from "@/lib/topology/activity";
import type { SceneModel } from "@/lib/scene/model";

/** Gap between a body's hard radius and where a flow visually terminates. */
export const PORT_PAD = 3;

export interface FlowGeom {
  flow: FlowObservation;
  path: SampledPath;
  /** Exact termination points, exposed for the debug overlay and tests. */
  ports: { from: Vec; to: Vec };
}

const BLEND_SAMPLES = 28;

function isArc(g: BodyGeom | ArcGeom): g is ArcGeom {
  return "a0" in g;
}

/** Direction from the core to a body, as an angle. */
function coreAngleOf(layout: SceneLayout, body: BodyGeom): number {
  return angleOf(layout.core.center, body.center);
}

/**
 * Signed sweep from `a0` to `a1` that passes through `via`. Of the two ways
 * around a circle, exactly one contains the waypoint (up to wrap): pick it.
 */
export function sweepThrough(a0: number, a1: number, via: number): number {
  const short = wrapAngle(a1 - a0);
  const long = short - Math.sign(short || 1) * Math.PI * 2;
  const contains = (sweep: number): boolean => {
    const rel = wrapAngle(via - a0);
    if (sweep >= 0) return rel >= 0 ? rel <= sweep : rel + Math.PI * 2 <= sweep;
    return rel <= 0 ? rel >= sweep : rel - Math.PI * 2 >= sweep;
  };
  return contains(short) ? short : long;
}

/** Tangent of a circle around `center` at angle `a`, oriented by sweep sign. */
function laneTangent(a: number, sweepSign: number): Vec {
  // d/da of (cos a, sin a) = (-sin a, cos a); flip when travelling negative.
  return { x: -Math.sin(a) * sweepSign, y: Math.cos(a) * sweepSign };
}

interface Run {
  points: Vec[];
  from: Vec;
  to: Vec;
}

function reverseRun(run: Run): Run {
  return { points: [...run.points].reverse(), from: run.to, to: run.from };
}

/** Services within this angular distance of the gateway connect directly. */
const GATEWAY_DIRECT_SPAN = (45 * Math.PI) / 180;

/**
 * WAN conduit: gateway aperture → service body. Direct radial blend when the
 * service sits near the gateway; otherwise ride the lane the SHORT way around
 * (never through the far hemisphere) and exit radially at the gateway.
 * Always built gateway→service; callers reverse for outbound orientation.
 */
function gatewayFlow(layout: SceneLayout, body: BodyGeom): Run {
  const { gateway } = layout;
  const core = layout.core.center;
  const bodyAngle = coreAngleOf(layout, body);
  const offset = wrapAngle(bodyAngle - gateway.angle);
  const inward = norm(sub(core, gateway.point));

  if (Math.abs(offset) <= GATEWAY_DIRECT_SPAN) {
    const port = pointOnCircle(body.center, body.r + PORT_PAD, angleOf(body.center, gateway.point));
    const points = sampleBlend(gateway.point, inward, port, norm(sub(port, gateway.point)), BLEND_SAMPLES);
    return { points, from: gateway.point, to: port };
  }

  // Lane route: gateway → (radial in to lane at gateway angle) → short sweep
  // to the body's angle → radial blend to the body port.
  const L = layout.laneR;
  const laneEntry = pointOnCircle(core, L, gateway.angle);
  const sweep = wrapAngle(bodyAngle - gateway.angle);
  const sgn = Math.sign(sweep || 1);
  const exitOff = ((40 + body.r * 0.5) / L) * sgn;
  const e2a = bodyAngle - exitOff;
  const freeSweep = sweep - exitOff;
  const e2 = pointOnCircle(core, L, e2a);
  const port = pointOnCircle(body.center, body.r + PORT_PAD, angleOf(body.center, e2));
  const arcSamples = Math.max(10, Math.ceil((Math.abs(freeSweep) * L) / 12));
  const points = joinRuns(
    sampleBlend(gateway.point, inward, laneEntry, laneTangent(gateway.angle, sgn), BLEND_SAMPLES),
    sampleArc(core, L, gateway.angle, freeSweep, arcSamples),
    sampleBlend(e2, laneTangent(e2a, sgn), port, norm(sub(port, e2)), BLEND_SAMPLES),
  );
  return { points, from: gateway.point, to: port };
}

/**
 * Control signal between two orbital bodies: an arc on the CONTROL LANE, a
 * circle just inside the service orbit, so the path can never clip a third
 * service body sitting between them on the orbit itself.
 */
const CONTROL_LANE_INSET = 48;

function orbitFlow(layout: SceneLayout, from: BodyGeom, to: BodyGeom): Run {
  const R = layout.serviceOrbitR - CONTROL_LANE_INSET;
  const core = layout.core.center;
  const aFrom = from.orbitAngle ?? coreAngleOf(layout, from);
  const aTo = to.orbitAngle ?? coreAngleOf(layout, to);
  const sweep = wrapAngle(aTo - aFrom);
  const sgn = Math.sign(sweep || 1);
  // Angular clearance each body consumes before the free arc.
  const offFrom = ((from.r + 16) / R) * sgn;
  const offTo = ((to.r + 16) / R) * sgn;
  const e1a = aFrom + offFrom;
  const e2a = aTo - offTo;
  const e1 = pointOnCircle(core, R, e1a);
  const e2 = pointOnCircle(core, R, e2a);
  const fromPort = pointOnCircle(from.center, from.r + PORT_PAD, angleOf(from.center, e1));
  const toPort = pointOnCircle(to.center, to.r + PORT_PAD, angleOf(to.center, e2));
  const freeSweep = wrapAngle(e2a - e1a);
  const arcSamples = Math.max(8, Math.ceil((Math.abs(freeSweep) * R) / 12));
  const points = joinRuns(
    sampleBlend(fromPort, norm(sub(e1, fromPort)), e1, laneTangent(e1a, sgn), BLEND_SAMPLES),
    sampleArc(core, R, e1a, freeSweep, arcSamples),
    sampleBlend(e2, laneTangent(e2a, sgn), toPort, norm(sub(toPort, e2)), BLEND_SAMPLES),
  );
  return { points, from: fromPort, to: toPort };
}

/**
 * Long flow: body → lane → body, arcing around the core through the given
 * hemisphere ("top" = playback, "bottom" = acquisition/import).
 */
function laneFlow(
  layout: SceneLayout,
  from: BodyGeom,
  to: BodyGeom,
  via: "top" | "bottom",
): Run {
  const core = layout.core.center;
  const L = layout.laneR;
  const aFrom = coreAngleOf(layout, from);
  const aTo = coreAngleOf(layout, to);
  const viaAngle = via === "top" ? -Math.PI / 2 : Math.PI / 2;
  const sweep = sweepThrough(aFrom, aTo, viaAngle);
  const sgn = Math.sign(sweep || 1);
  // Consume some sweep on each side for the on/off blends — more for larger
  // bodies, so the transition into a big storage body stays graceful.
  const entryOff = ((40 + from.r * 0.5) / L) * sgn;
  const exitOff = ((40 + to.r * 0.5) / L) * sgn;
  const e1a = aFrom + entryOff;
  const e2a = aTo - exitOff;
  const e1 = pointOnCircle(core, L, e1a);
  const e2 = pointOnCircle(core, L, e2a);
  const fromPort = pointOnCircle(from.center, from.r + PORT_PAD, angleOf(from.center, e1));
  const toPort = pointOnCircle(to.center, to.r + PORT_PAD, angleOf(to.center, e2));
  const freeSweep = sweep - entryOff - exitOff;
  const arcSamples = Math.max(10, Math.ceil((Math.abs(freeSweep) * L) / 12));
  const points = joinRuns(
    sampleBlend(fromPort, norm(sub(e1, fromPort)), e1, laneTangent(e1a, sgn), BLEND_SAMPLES),
    sampleArc(core, L, e1a, freeSweep, arcSamples),
    sampleBlend(e2, laneTangent(e1a + freeSweep, sgn), toPort, norm(sub(toPort, e2)), BLEND_SAMPLES),
  );
  return { points, from: fromPort, to: toPort };
}

/**
 * Direct body → body flow (cross-pool copy): one blend between facing ports,
 * tangents along the chord so the curve stays gentle and readable.
 */
function directFlow(from: BodyGeom, to: BodyGeom): Run {
  const dir = norm(sub(to.center, from.center));
  const fromPort = pointOnCircle(from.center, from.r + PORT_PAD, angleOf(from.center, to.center));
  const toPort = pointOnCircle(to.center, to.r + PORT_PAD, angleOf(to.center, from.center));
  const points = sampleBlend(fromPort, dir, toPort, dir, BLEND_SAMPLES);
  return { points, from: fromPort, to: toPort };
}

/** Resolve one flow to geometry. Returns null when an endpoint has no body. */
export function routeFlow(layout: SceneLayout, flow: FlowObservation): FlowGeom | null {
  const fromG = bodyForEndpoint(layout, flow.from);
  const toG = bodyForEndpoint(layout, flow.to);
  if (!fromG || !toG) return null;

  let run: Run;
  if (isArc(fromG) && !isArc(toG)) {
    run = gatewayFlow(layout, toG); // gateway → service, matching from/to
  } else if (!isArc(fromG) && isArc(toG)) {
    run = reverseRun(gatewayFlow(layout, fromG)); // service → gateway
  } else if (isArc(fromG) || isArc(toG)) {
    return null; // arc→arc is not a meaningful flow
  } else if (flow.kind === "control") {
    run = orbitFlow(layout, fromG, toG);
  } else if (flow.kind === "import-copy") {
    run = directFlow(fromG, toG);
  } else if (flow.kind === "playback") {
    run = laneFlow(layout, fromG, toG, "top");
  } else {
    // storage-transfer, organize, and any future long acquisition flow ride
    // the bottom hemisphere.
    run = laneFlow(layout, fromG, toG, "bottom");
  }

  return { flow, path: samplePath(run.points), ports: { from: run.from, to: run.to } };
}

/** Route every flow in the model. Order is stable (model order). */
export function routeFlows(layout: SceneLayout, flows: FlowObservation[]): FlowGeom[] {
  const out: FlowGeom[] = [];
  for (const f of flows) {
    const g = routeFlow(layout, f);
    if (g && g.path.totalLength > 1 && g.path.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      out.push(g);
    }
  }
  return out;
}

/**
 * The dormant structural topology: the canonical routes work WOULD travel,
 * drawn as faint constellation lines even when nothing is flowing (spec: an
 * unavailable/quiet system shows honest dormant paths, never fake activity).
 * Only routes whose endpoints are actually configured/present are included.
 */
export function dormantRoutes(layout: SceneLayout, model: SceneModel): FlowGeom[] {
  const has = (id: string): boolean =>
    model.services.some((s) => s.id === id && s.status !== "not-configured");
  const downloadStore: FlowObservation["to"] | null = model.downloadPoolName
    ? { kind: "pool", name: model.downloadPoolName }
    : layout.genericStorage
      ? { kind: "storage" }
      : null;
  const mediaStore: FlowObservation["from"] | null = model.mediaPoolName
    ? { kind: "pool", name: model.mediaPoolName }
    : layout.genericStorage
      ? { kind: "storage" }
      : null;

  const stubs: Array<Pick<FlowObservation, "kind" | "from" | "to"> | null> = [
    has("qbittorrent")
      ? { kind: "wan-transfer", from: { kind: "network" }, to: { kind: "service", id: "qbittorrent" } }
      : null,
    has("qbittorrent") && downloadStore
      ? { kind: "storage-transfer", from: { kind: "service", id: "qbittorrent" }, to: downloadStore }
      : null,
    has("sonarr") && has("qbittorrent")
      ? { kind: "control", from: { kind: "service", id: "sonarr" }, to: { kind: "service", id: "qbittorrent" } }
      : null,
    has("radarr") && has("qbittorrent")
      ? { kind: "control", from: { kind: "service", id: "radarr" }, to: { kind: "service", id: "qbittorrent" } }
      : null,
    has("jellyfin") && mediaStore
      ? { kind: "playback", from: mediaStore, to: { kind: "service", id: "jellyfin" } }
      : null,
    has("jellyfin")
      ? { kind: "egress", from: { kind: "service", id: "jellyfin" }, to: { kind: "network" } }
      : null,
  ];

  const out: FlowGeom[] = [];
  for (const stub of stubs) {
    if (!stub) continue;
    const flow: FlowObservation = {
      id: `dormant:${stub.kind}`,
      plane: "data",
      evidence: "state-only",
      freshness: "live",
      channels: [],
      provenance: "dormant topology route",
      label: "",
      updatedAt: null,
      ...stub,
    };
    const g = routeFlow(layout, flow);
    if (g) out.push(g);
  }
  return out;
}

/** Minimum clearance between a path and a body's atmosphere, for tests. */
export function pathClearance(path: SampledPath, body: BodyGeom): number {
  let min = Infinity;
  for (const p of path.points) {
    const d = dist(p, body.center) - body.atmosphereR;
    if (d < min) min = d;
  }
  return min;
}
