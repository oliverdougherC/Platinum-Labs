import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaRequestIcon } from "@/components/ui/icons";

describe("MediaRequestIcon", () => {
  it("keeps the request glyph inside the 20x20 frame with stable geometry", () => {
    const { container } = render(<MediaRequestIcon />);
    const svg = container.querySelector("svg");
    const rect = container.querySelector("rect");
    const path = container.querySelector("path");
    expect(svg).toHaveAttribute("viewBox", "0 0 20 20");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(rect?.getAttribute("x")).toBe("2.75");
    expect(rect?.getAttribute("y")).toBe("4.25");
    expect(rect?.getAttribute("width")).toBe("9.5");
    expect(rect?.getAttribute("height")).toBe("11");
    expect(path?.getAttribute("d")).toBe("m5.5 2.75 2 2 2-2M15.25 8.75v6.5M12 12h6.5");
  });
});
