/**
 * Background field (PLA-266 rebuild) — restrained deterministic depth.
 *
 * Three sparse star layers (for near-imperceptible parallax), a faint dust
 * band along the composition diagonal, and a vignette. All geometry derives
 * from the fixed scene seed: identical on every mount, every machine.
 *
 * Deliberately NOT here: nebula wallpaper, bright stars, animated blobs.
 * The field should disappear under direct inspection and only add depth
 * peripherally (spec §7).
 */

import { makeRng, SCENE_SEED } from "@/lib/scene/rng";

export interface Star {
  /** 0..1 fractional world position (scaled by world size at draw time). */
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export interface StarLayer {
  stars: Star[];
  /** Parallax factor: how much of the ambient drift this layer receives. */
  drift: number;
}

export interface DustPatch {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export interface BackgroundField {
  layers: StarLayer[];
  dust: DustPatch[];
}

export function buildBackground(): BackgroundField {
  const rng = makeRng(SCENE_SEED);
  const layers: StarLayer[] = [];
  // Far → near: more/fainter to fewer/slightly brighter.
  const specs = [
    { count: 90, rMin: 0.4, rMax: 0.8, aMin: 0.05, aMax: 0.12, drift: 0.25 },
    { count: 52, rMin: 0.5, rMax: 1.1, aMin: 0.07, aMax: 0.17, drift: 0.55 },
    { count: 26, rMin: 0.7, rMax: 1.6, aMin: 0.1, aMax: 0.24, drift: 1 },
  ];
  for (const spec of specs) {
    const stars: Star[] = [];
    for (let i = 0; i < spec.count; i++) {
      stars.push({
        x: rng(),
        y: rng(),
        r: spec.rMin + rng() * (spec.rMax - spec.rMin),
        alpha: spec.aMin + rng() * (spec.aMax - spec.aMin),
      });
    }
    layers.push({ stars, drift: spec.drift });
  }

  // A whisper of dust rising along the lower-left → upper-right diagonal.
  const dust: DustPatch[] = [];
  for (let i = 0; i < 7; i++) {
    const t = (i + rng() * 0.6) / 7;
    dust.push({
      x: 0.14 + t * 0.72 + (rng() - 0.5) * 0.1,
      y: 0.82 - t * 0.62 + (rng() - 0.5) * 0.12,
      r: 0.09 + rng() * 0.1,
      alpha: 0.02 + rng() * 0.016,
    });
  }
  return { layers, dust };
}
