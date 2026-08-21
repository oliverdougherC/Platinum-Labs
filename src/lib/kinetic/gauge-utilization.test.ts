import { describe, expect, it } from "vitest";
import { gaugePercent, gaugeUtilizationLabel } from "./gauge-utilization";

describe("gauge utilization", () => {
  it("rounds one shared bounded percentage for fill and copy", () => {
    const percent = gaugePercent(0.374);
    expect(percent).toBe(37);
    expect(gaugeUtilizationLabel("available", percent)).toBe("37%");
    expect(gaugePercent(1.2)).toBe(100);
    expect(gaugePercent(0)).toBe(0);
  });

  it("keeps unknown and stale states distinct from zero", () => {
    expect(gaugePercent(null)).toBeNull();
    expect(gaugePercent(Number.NaN)).toBeNull();
    expect(gaugePercent(-0.1)).toBeNull();
    expect(gaugeUtilizationLabel("available", null)).toBe("—");
    expect(gaugeUtilizationLabel("unavailable", null)).toBe("—");
    expect(gaugeUtilizationLabel("stale", 37)).toBe("stale");
    expect(gaugeUtilizationLabel("available", 0)).toBe("0%");
  });
});
