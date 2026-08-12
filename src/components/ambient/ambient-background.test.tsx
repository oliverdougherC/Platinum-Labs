import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { AmbientBackground } from "@/components/ambient/ambient-background";

describe("AmbientBackground", () => {
  it("is decorative: hidden from assistive tech and non-interactive", () => {
    const { getByTestId } = render(<AmbientBackground />);
    const root = getByTestId("ambient-root");
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root).toHaveClass("ambient-root");
  });

  it("renders exactly three drifting color fields", () => {
    const { container } = render(<AmbientBackground />);
    expect(container.querySelectorAll(".ambient-orb")).toHaveLength(3);
  });

  it("includes the static grid and grain layers", () => {
    const { container } = render(<AmbientBackground />);
    expect(container.querySelector(".ambient-grid")).not.toBeNull();
    expect(container.querySelector(".ambient-noise")).not.toBeNull();
  });
});
