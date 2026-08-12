/**
 * Resolve design tokens to literal `rgb()` strings for SVG chart use (PLA-176).
 *
 * CSS `var()` does NOT resolve inside SVG *presentation attributes* (which is
 * how Recharts sets `stroke`/`fill`), so charts can't reference
 * `rgb(var(--color-accent))` there. We instead read the same
 * `colorTokens` source of truth and emit concrete `rgb(r,g,b)` — keeping charts
 * on the design system without relying on CSS custom properties in attributes.
 */

import { colorTokens, type ColorTokenName } from "@/lib/design/tokens";

/** Concrete `rgb(r,g,b)` for a token, optionally with alpha. */
export function token(name: ColorTokenName, alpha?: number): string {
  const [r, g, b] = colorTokens[name];
  return alpha === undefined
    ? `rgb(${r},${g},${b})`
    : `rgba(${r},${g},${b},${alpha})`;
}

/** Ordered series colors for multi-series charts (distinct hues). */
export const seriesColors: string[] = [
  token("accent"),
  token("ok"),
  token("warn"),
];
