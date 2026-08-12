import { describe, expect, it } from "vitest";
import { MAX_TINT, tintForHour } from "@/lib/design/ambient";

describe("tintForHour", () => {
  it("keeps both factors within the subtle bound at all hours", () => {
    for (let h = 0; h < 24; h += 0.5) {
      const { warm, dim } = tintForHour(h);
      expect(warm).toBeGreaterThanOrEqual(0);
      expect(warm).toBeLessThanOrEqual(MAX_TINT);
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(MAX_TINT);
    }
  });

  it("normalizes out-of-range hours", () => {
    expect(tintForHour(24)).toEqual(tintForHour(0));
    expect(tintForHour(26.5)).toEqual(tintForHour(2.5));
    expect(tintForHour(-1)).toEqual(tintForHour(23));
  });

  it("is dimmest in the small hours, brightest mid-afternoon", () => {
    expect(tintForHour(3).dim).toBeGreaterThan(tintForHour(15).dim);
    expect(tintForHour(15).dim).toBeCloseTo(0, 2);
  });

  it("is warmest in the evening, ~neutral mid-day and deep night", () => {
    expect(tintForHour(20).warm).toBeGreaterThan(tintForHour(12).warm);
    expect(tintForHour(20).warm).toBeGreaterThan(tintForHour(4).warm);
    expect(tintForHour(12).warm).toBeCloseTo(0, 2);
  });
});
