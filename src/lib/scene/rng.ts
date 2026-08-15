/**
 * Deterministic PRNG for the scene (PLA-266 rebuild).
 *
 * The background star field, surface speckle, and belt jitter must be
 * identical across mounts and machines so screenshot review is reproducible:
 * everything decorative derives from a FIXED seed, never Math.random().
 */

/** mulberry32 — tiny, fast, good enough for scenery. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The one scene seed. Changing it is a deliberate art-direction decision. */
export const SCENE_SEED = 0x50394130; // "P9A0"
