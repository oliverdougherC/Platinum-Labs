/**
 * Design tokens — the single source of truth for the visual system (PLA-173).
 *
 * Color values are stored as `[r, g, b]` channel triplets so they can be:
 *   1. emitted as `--color-*` CSS custom properties (see globals.css), and
 *   2. checked for WCAG contrast by automated tests (contrast.test.ts).
 *
 * Components must consume these via Tailwind token classes (`text-fg`,
 * `bg-surface`, `border-hairline`, …) rather than hard-coding hex values, so the
 * palette can evolve in one place.
 *
 * This module is isomorphic and secret-free.
 */

export type Rgb = readonly [number, number, number];

/**
 * Canonical palette. Kept intentionally small: one background family, a raised
 * surface family, hairline separators, three text weights, one accent, and
 * three semantic health colors. These must stay in sync with globals.css — the
 * `tokens sync` test asserts it.
 */
export const colorTokens = {
  // Backgrounds — the quiet, near-black canvas and its raised surfaces.
  bg: [9, 11, 16],
  surface: [20, 24, 33],
  "surface-2": [28, 33, 45],

  // Structure — hairline separators; deliberately faint but visible.
  hairline: [44, 51, 66],
  border: [58, 66, 84],

  // Text weights.
  fg: [236, 239, 246], // primary
  muted: [166, 176, 194], // secondary — must stay AA on bg & surface
  faint: [136, 146, 166], // tertiary/eyebrow — large/secondary text only

  // Accent + semantic health. Tuned as *text-legible* variants on dark bg.
  accent: [138, 180, 255],
  ok: [116, 214, 152],
  warn: [242, 197, 112],
  danger: [244, 132, 132],
} as const satisfies Record<string, Rgb>;

export type ColorTokenName = keyof typeof colorTokens;

/**
 * Semantic visual states from the spec: ambient (quiet/idle), active (normal
 * meaningful activity), attention (something needs the operator). Downstream
 * components key their accent/ring/border treatments off these names so state
 * styling is consistent across modules.
 */
export const visualStates = ["ambient", "active", "attention"] as const;
export type VisualState = (typeof visualStates)[number];

/** Maps a visual state to the semantic accent token driving its treatment. */
export const stateAccent: Record<VisualState, ColorTokenName> = {
  ambient: "hairline",
  active: "accent",
  attention: "warn",
};

/**
 * Type scale — a small, disciplined ramp (rem). Names map to roles rather than
 * raw sizes so intent stays legible in markup.
 */
export const typeScale = {
  display: "2rem", // page status / greeting
  title: "1.125rem", // module title
  metric: "1.5rem", // primary metric value
  body: "0.9375rem", // row / body text
  meta: "0.8125rem", // secondary metadata
  eyebrow: "0.6875rem", // uppercase/letterspaced eyebrow
} as const;

/** Corner radii. */
export const radii = {
  sm: "0.375rem",
  md: "0.625rem",
  lg: "0.875rem",
  xl: "1.125rem",
} as const;
