/**
 * Flow router (PLA-266 rebuild) — ONE curvature language for every connection.
 *
 * Rules:
 *  - a path begins and ends ON a body boundary circle (+PAD), entering and
 *    leaving along the local radial direction — never at a body center, never
 *    at an arbitrary offset;
 *  - short flows (network↔service) are single radial blends between the
 *    concentric network arc and the service body;
 *  - downloader→arr handoffs travel along the SERVICE ORBIT circle itself;
 *  - long flows (import, playback) blend onto the one routing LANE circle
 *    around the core and arc along it — playback through the TOP hemisphere,
 *    import through the BOTTOM — so long paths are recognizably siblings and
 *    never cross the compute star;
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
  scale,
  sub,
  joinRuns,
  wrapAngle,
  type SampledPath,
  type Vec,
} from "@/lib/scene/geom";
import { bodyForEndpoint, type ArcGeom, type BodyGeom, type SceneLayout } from "@/lib/scene/layout";
import type { FlowState } from "@/lib/topology/activity";

/** Gap between a body's hard radius and where a flow visually terminates. */
export const PORT_PAD = 3;

export interface FlowGeom {
  flow: FlowState;
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

/**
 * Radial flow between the network boundary arc and an orbital body.
 * `inward` = network → body; otherwise body → network.
 */
function radialFlow(
  layout: SceneLayout,
  arc: ArcGeom,
  body: BodyGeom,
  inward: boolean,
): { points: Vec[]; from: Vec; to: Vec } {
  const a = coreAngleOf(layout, body);
  const arcPoint = pointOnCircle(arc.center, arc.r, a);
  const radialIn = norm(sub(layout.core.center, arcPoint));
  // The body port faces the network (its outer side).
  const port = pointOnCircle(body.center, body.r + PORT_PAD, a);
  if (inward) {
    const points = sampleBlend(arcPoint, radialIn, port, radialIn, BLEND_SAMPLES);
    return { points, from: arcPoint, to: port };
  }
  const radialOut = scale(radialIn, -1);
  const points = sampleBlend(port, radialOut, arcPoint, radialOut, BLEND_SAMPLES);
  return { points, from: port, to: arcPoint };
}

/**
 * Handoff between two orbital bodies: an arc on the HANDOFF LANE, a circle
 * just inside the service orbit, so the path can never clip a third service
 * body sitting between them on the orbit itself.
 */
const HANDOFF_LANE_INSET = 42;

function orbitFlow(
  layout: SceneLayout,
  from: BodyGeom,
  to: BodyGeom,
): { points: Vec[]; from: Vec; to: Vec } {
  const R = layout.serviceOrbitR - HANDOFF_LANE_INSET;
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
 * hemisphere ("top" = playback, "bottom" = import).
 */
function laneFlow(
  layout: SceneLayout,
  from: BodyGeom,
  to: BodyGeom,
  via: "top" | "bottom",
): { points: Vec[]; from: Vec; to: Vec } {
  const core = layout.core.center;
  const L = layout.laneR;
  const aFrom = coreAngleOf(layout, from);
  const aTo = coreAngleOf(layout, to);
  const viaAngle = via === "top" ? -Math.PI / 2 : Math.PI / 2;
  const sweep = sweepThrough(aFrom, aTo, viaAngle);
  const sgn = Math.sign(sweep || 1);
  // Consume a little sweep on each side for the on/off blends.
  const entryOff = (44 / L) * sgn;
  const e1a = aFrom + entryOff;
  const e2a = aTo - entryOff;
  const e1 = pointOnCircle(core, L, e1a);
  const e2 = pointOnCircle(core, L, e2a);
  const fromPort = pointOnCircle(from.center, from.r + PORT_PAD, angleOf(from.center, e1));
  const toPort = pointOnCircle(to.center, to.r + PORT_PAD, angleOf(to.center, e2));
  const freeSweep = sweep - 2 * entryOff;
  const arcSamples = Math.max(10, Math.ceil((Math.abs(freeSweep) * L) / 12));
  const points = joinRuns(
    sampleBlend(fromPort, norm(sub(e1, fromPort)), e1, laneTangent(e1a, sgn), BLEND_SAMPLES),
    sampleArc(core, L, e1a, freeSweep, arcSamples),
    sampleBlend(e2, laneTangent(e1a + freeSweep, sgn), toPort, norm(sub(toPort, e2)), BLEND_SAMPLES),
  );
  return { points, from: fromPort, to: toPort };
}

/** Resolve one flow to geometry. Returns null when an endpoint has no body. */
export function routeFlow(layout: SceneLayout, flow: FlowState): FlowGeom | null {
  const fromG = bodyForEndpoint(layout, flow.from);
  const toG = bodyForEndpoint(layout, flow.to);
  if (!fromG || !toG) return null;

  let run: { points: Vec[]; from: Vec; to: Vec };
  if (isArc(fromG) && !isArc(toG)) {
    run = radialFlow(layout, fromG, toG, true);
  } else if (!isArc(fromG) && isArc(toG)) {
    run = radialFlow(layout, toG, fromG, false);
  } else if (isArc(fromG) || isArc(toG)) {
    return null; // arc→arc is not a meaningful flow
  } else if (flow.kind === "handoff") {
    run = orbitFlow(layout, fromG, toG);
  } else if (flow.kind === "playback") {
    run = laneFlow(layout, fromG, toG, "top");
  } else {
    run = laneFlow(layout, fromG, toG, "bottom");
  }

  return { flow, path: samplePath(run.points), ports: { from: run.from, to: run.to } };
}

/** Route every flow in the model. Order is stable (model order). */
export function routeFlows(layout: SceneLayout, flows: FlowState[]): FlowGeom[] {
  const out: FlowGeom[] = [];
  for (const f of flows) {
    const g = routeFlow(layout, f);
    if (g && g.path.totalLength > 1 && g.path.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      out.push(g);
    }
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
