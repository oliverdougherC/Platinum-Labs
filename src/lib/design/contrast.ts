/**
 * WCAG 2.1 relative-luminance and contrast-ratio math.
 *
 * Used by automated accessibility checks (contrast.test.ts) to guarantee that
 * essential text tokens meet AA against the surfaces they render on. Pure and
 * isomorphic.
 */

import type { Rgb } from "@/lib/design/tokens";

/** Linearize an 8-bit sRGB channel per WCAG. */
function linearize(channel8bit: number): number {
  const c = channel8bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Contrast ratio between two colors, in the range [1, 21]. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** AA threshold: 4.5:1 for normal text, 3:1 for large text (>=18.66px bold / 24px). */
export function meetsAA(ratio: number, large = false): boolean {
  return ratio >= (large ? 3 : 4.5);
}

/** Convenience: does foreground meet AA on background? */
export function textMeetsAA(fg: Rgb, bg: Rgb, large = false): boolean {
  return meetsAA(contrastRatio(fg, bg), large);
}
