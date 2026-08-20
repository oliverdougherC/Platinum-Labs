import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaRequestIcon } from "@/components/ui/icons";

describe("MediaRequestIcon", () => {
  it("renders a hidden decorative media frame with a centered add glyph", () => {
    const { container } = render(<MediaRequestIcon />);
    const svg = container.querySelector("svg");
    const paths = container.querySelectorAll("path");
    const rect = container.querySelector("rect");

    expect(svg).toHaveAttribute("viewBox", "0 0 20 20");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(rect).toHaveAttribute("rx", "2");
    expect(paths).toHaveLength(2);

    const [playGlyph, addGlyph] = paths;
    expect(playGlyph).toHaveAttribute("fill", "currentColor");
    expect(playGlyph).toHaveAttribute("stroke", "none");
    expect(playGlyph?.getAttribute("d")).toMatch(/Z$/);
    expect(addGlyph?.getAttribute("d")).toMatch(/[Vv].+[Hh]/);

    expect(Number.parseFloat(rect?.getAttribute("width") ?? "0")).toBeGreaterThan(0);
    expect(Number.parseFloat(rect?.getAttribute("height") ?? "0")).toBeGreaterThan(0);
  });
});
