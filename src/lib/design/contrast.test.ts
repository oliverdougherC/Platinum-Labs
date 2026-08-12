import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { colorTokens, type Rgb } from "@/lib/design/tokens";
import { contrastRatio, meetsAA } from "@/lib/design/contrast";

const SURFACES: Array<[string, Rgb]> = [
  ["bg", colorTokens.bg],
  ["surface", colorTokens.surface],
  ["surface-2", colorTokens["surface-2"]],
];

describe("contrast math", () => {
  it("matches known WCAG references", () => {
    // black vs white is exactly 21:1
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    // identical colors are 1:1
    expect(contrastRatio([100, 100, 100], [100, 100, 100])).toBeCloseTo(1, 5);
  });
});

describe("essential text meets WCAG AA on every surface", () => {
  const textWeights: Array<[string, Rgb]> = [
    ["fg", colorTokens.fg],
    ["muted", colorTokens.muted],
    ["faint", colorTokens.faint],
  ];

  for (const [textName, text] of textWeights) {
    for (const [surfName, surf] of SURFACES) {
      it(`${textName} on ${surfName} >= 4.5:1`, () => {
        const ratio = contrastRatio(text, surf);
        expect(
          ratio,
          `${textName}/${surfName} was ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("semantic status colors are legible as small labels", () => {
  const semantic: Array<[string, Rgb]> = [
    ["accent", colorTokens.accent],
    ["ok", colorTokens.ok],
    ["warn", colorTokens.warn],
    ["danger", colorTokens.danger],
  ];

  for (const [name, color] of semantic) {
    for (const surfName of ["bg", "surface"] as const) {
      it(`${name} on ${surfName} meets AA normal text`, () => {
        expect(meetsAA(contrastRatio(color, colorTokens[surfName]))).toBe(true);
      });
    }
  }
});

describe("globals.css stays in sync with the token source of truth", () => {
  it("every --color-* var equals its token triplet", () => {
    const cssPath = resolve(process.cwd(), "src/app/globals.css");
    const css = readFileSync(cssPath, "utf8");

    const found = new Map<string, string>();
    const re = /--color-([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g;
    for (const m of css.matchAll(re)) {
      found.set(m[1]!, `${m[2]} ${m[3]} ${m[4]}`);
    }

    for (const [name, rgb] of Object.entries(colorTokens)) {
      expect(found.get(name), `missing --color-${name} in globals.css`).toBe(
        rgb.join(" "),
      );
    }
  });
});
