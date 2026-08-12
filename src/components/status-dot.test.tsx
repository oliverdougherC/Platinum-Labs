import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusDot } from "@/components/status-dot";

describe("StatusDot", () => {
  it("renders a default label per status (color is not the only signal)", () => {
    render(<StatusDot status="healthy" />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("accepts a custom label (e.g. pool health)", () => {
    render(<StatusDot status="degraded" label="DEGRADED" />);
    expect(screen.getByText("DEGRADED")).toBeInTheDocument();
  });
});
