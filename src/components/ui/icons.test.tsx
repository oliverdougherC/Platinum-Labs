import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaRequestIcon } from "@/components/ui/icons";

describe("MediaRequestIcon", () => {
  it("renders an unclipped media frame and a separated add glyph", () => {
    const { container } = render(<MediaRequestIcon />);
    const svg = container.querySelector("svg");
    const paths = container.querySelectorAll("path");
    const rect = container.querySelector("rect");

    expect(svg).toHaveAttribute("viewBox", "0 0 20 20");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(rect).toHaveAttribute("x", "2.5");
    expect(rect).toHaveAttribute("y", "4.75");
    expect(rect).toHaveAttribute("width", "9.25");
    expect(rect).toHaveAttribute("height", "9");
    expect(rect).toHaveAttribute("rx", "2");
    expect(paths).toHaveLength(2);

    const [playGlyph, addGlyph] = paths;
    expect(playGlyph).toHaveAttribute("d", "M6.15 7.15 L9.75 9.25 L6.15 11.35 Z");
    expect(playGlyph).toHaveAttribute("fill", "currentColor");
    expect(playGlyph).toHaveAttribute("stroke", "none");
    expect(addGlyph).toHaveAttribute(
      "d",
      "M15.25 10.25 V15.25 M12.75 12.75 H17.75",
    );
    expect(addGlyph).not.toHaveAttribute("fill");

    const frameRight =
      Number.parseFloat(rect?.getAttribute("x") ?? "0") +
      Number.parseFloat(rect?.getAttribute("width") ?? "0");
    const plusLeft = 12.75;
    expect(plusLeft - frameRight).toBeGreaterThanOrEqual(1);
  });
});
