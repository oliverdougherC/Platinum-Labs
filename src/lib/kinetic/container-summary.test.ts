import { describe, expect, it } from "vitest";
import { formatContainerRuntimeSummary } from "./container-summary";

describe("formatContainerRuntimeSummary", () => {
  it("names the numerator as running containers and the denominator as total containers", () => {
    expect(formatContainerRuntimeSummary(41, 44)).toBe(
      "41 / 44 containers running",
    );
    expect(formatContainerRuntimeSummary(1, 1)).toBe("1 / 1 container running");
  });

  it("uses a plain count when no running ratio is useful", () => {
    expect(formatContainerRuntimeSummary(null, 42)).toBe("42 containers");
    expect(formatContainerRuntimeSummary(null, 1)).toBe("1 container");
    expect(formatContainerRuntimeSummary(0, 0)).toBe("0 containers");
  });

  it("suppresses impossible or unavailable counts", () => {
    expect(formatContainerRuntimeSummary(null, null)).toBeNull();
    expect(formatContainerRuntimeSummary(3, 2)).toBeNull();
    expect(formatContainerRuntimeSummary(-1, 2)).toBeNull();
  });
});
