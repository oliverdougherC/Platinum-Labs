/**
 * Scene geometry primitives (PLA-266 rebuild) — pure math, no canvas, no React.
 *
 * Everything the layout engine, flow router, and tests share: vectors, angles,
 * circle boundary intersections, and the arc/blend sampling that gives every
 * connection in the scene one curvature language.
 */

export interface Vec {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export function vec(x: number, y: number): Vec {
  return { x, y };
}

export function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec, s: number): Vec {
  return { x: a.x * s, y: a.y * s };
}

export function len(a: Vec): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function norm(a: Vec): Vec {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec, b: Vec, t: number): Vec {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

/** Angle of point `p` as seen from `center`, in radians. */
export function angleOf(center: Vec, p: Vec): number {
  return Math.atan2(p.y - center.y, p.x - center.x);
}

export function pointOnCircle(center: Vec, r: number, angle: number): Vec {
  return { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r };
}

/** Normalize an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  while (a <= -Math.PI) a += TAU;
  while (a > Math.PI) a -= TAU;
  return a;
}

/**
 * Signed shortest angular difference b−a in (-π, π]. Positive = counter…
 * (canvas y grows downward, so positive means clockwise on screen).
 */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/**
 * The point where the segment/ray from `from` toward `to` crosses the circle
 * around `center` with radius `r` — i.e. the geometrically correct place a
 * connection meets a body boundary (plus any visual padding baked into `r`).
 */
export function boundaryPoint(center: Vec, r: number, toward: Vec): Vec {
  return pointOnCircle(center, r, angleOf(center, toward));
}

/** Cubic Bézier point. */
export function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * A sampled path: dense polyline points plus cumulative arc length, so the
 * renderer can place moving packets at exact distances and tests can check
 * clearance at every sample. Immutable after construction.
 */
export interface SampledPath {
  points: Vec[];
  /** cumulative length at each point; last entry = total length. */
  lengths: number[];
  totalLength: number;
}

export function samplePath(points: Vec[]): SampledPath {
  const lengths: number[] = new Array(points.length);
  lengths[0] = 0;
  for (let i = 1; i < points.length; i++) {
    lengths[i] = lengths[i - 1]! + dist(points[i - 1]!, points[i]!);
  }
  return { points, lengths, totalLength: lengths[points.length - 1] ?? 0 };
}

/** Point at arc-length distance `d` along the path (clamped). */
export function pointAtLength(path: SampledPath, d: number): Vec {
  const { points, lengths, totalLength } = path;
  if (points.length === 0) return { x: NaN, y: NaN };
  if (d <= 0) return points[0]!;
  if (d >= totalLength) return points[points.length - 1]!;
  // Binary search the containing segment.
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const span = lengths[hi]! - lengths[lo]!;
  const t = span > 0 ? (d - lengths[lo]!) / span : 0;
  return lerpVec(points[lo]!, points[hi]!, t);
}

/** Unit tangent at arc-length distance `d` (central difference). */
export function tangentAtLength(path: SampledPath, d: number): Vec {
  const eps = Math.max(1, path.totalLength / 200);
  const a = pointAtLength(path, Math.max(0, d - eps));
  const b = pointAtLength(path, Math.min(path.totalLength, d + eps));
  return norm(sub(b, a));
}

/** Minimum distance from any path sample to a point. */
export function minDistanceTo(path: SampledPath, p: Vec): number {
  let min = Infinity;
  for (const q of path.points) {
    const d = dist(q, p);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Sample an arc around `center` from `fromAngle`, sweeping `sweep` radians
 * (signed), at radius `r`. Returns `n+1` points.
 */
export function sampleArc(
  center: Vec,
  r: number,
  fromAngle: number,
  sweep: number,
  n: number,
): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(pointOnCircle(center, r, fromAngle + (sweep * i) / n));
  }
  return pts;
}

/**
 * Smoothly blend from point `a` (with unit tangent `ta`) to point `b` (with
 * unit tangent `tb`) using a cubic whose control-handle length is a fraction
 * of the chord — the single blend primitive every connection uses, so all
 * transitions share one curvature character.
 */
export function sampleBlend(
  a: Vec,
  ta: Vec,
  b: Vec,
  tb: Vec,
  n: number,
  handle = 0.38,
): Vec[] {
  const chord = dist(a, b);
  const h = chord * handle;
  const c1 = add(a, scale(ta, h));
  const c2 = sub(b, scale(tb, h));
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(cubicAt(a, c1, c2, b, i / n));
  }
  return pts;
}

/** Concatenate point runs, dropping duplicated joints. */
export function joinRuns(...runs: Vec[][]): Vec[] {
  const out: Vec[] = [];
  for (const run of runs) {
    for (const p of run) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
      out.push(p);
    }
  }
  return out;
}
