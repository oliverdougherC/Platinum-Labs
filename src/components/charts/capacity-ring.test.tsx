import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CapacityRing } from "@/components/charts/capacity-ring";

describe("CapacityRing", () => {
  it("shows the percentage label", () => {
    render(<CapacityRing fraction={0.62} label="tank" />);
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("communicates band status to assistive tech (not color-only)", () => {
    const { rerender } = render(<CapacityRing fraction={0.5} label="tank" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /within normal range/,
    );
    rerender(<CapacityRing fraction={0.96} label="tank" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /critically full/,
    );
  });

  it("clamps out-of-range fractions", () => {
    render(<CapacityRing fraction={1.5} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
