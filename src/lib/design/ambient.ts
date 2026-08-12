/**
 * Time-of-day ambient tint logic (PLA-174).
 *
 * Pure and isomorphic so it can be unit-tested and run on the client without
 * pulling in DOM APIs. Returns two tiny, bounded factors used to nudge the
 * ambient background: a warm wash and a dim veil. Magnitudes are intentionally
 * small — the change should be noticeable only across hours, never distracting.
 */

export interface AmbientTint {
  /** Warm overlay opacity, 0..MAX_TINT. Peaks in the evening. */
  warm: number;
  /** Dark veil opacity, 0..MAX_TINT. Peaks in the small hours. */
  dim: number;
}

/** Hard cap on either factor so the effect can never overwhelm the design. */
export const MAX_TINT = 0.14;

function clamp01(n: number, max: number): number {
  return Math.min(Math.max(n, 0), max);
}

/**
 * Map an hour [0,24) to a subtle tint.
 *
 * - `dim` follows a cosine that peaks around 03:00 and bottoms out at 15:00.
 * - `warm` peaks around 20:00 (golden/evening) and is ~0 mid-day and deep night.
 */
export function tintForHour(hour: number): AmbientTint {
  // Normalize into [0,24) so 24, -1, 26.5 etc. behave.
  const h = ((hour % 24) + 24) % 24;

  const TWO_PI = Math.PI * 2;
  // Dim: cosine peaking at h=3 (small hours) and bottoming out at h=15.
  const dim = clamp01(
    MAX_TINT * (0.5 + 0.5 * Math.cos(((h - 3) / 24) * TWO_PI)),
    MAX_TINT,
  );

  // Warm: raised cosine centered on h=20 with a ~8h support, else 0.
  const distance = Math.min(Math.abs(h - 20), 24 - Math.abs(h - 20));
  const warmShape = distance >= 6 ? 0 : 0.5 + 0.5 * Math.cos((distance / 6) * Math.PI);
  const warm = clamp01(MAX_TINT * warmShape, MAX_TINT);

  return {
    warm: Number(warm.toFixed(4)),
    dim: Number(dim.toFixed(4)),
  };
}
