import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Metric } from "@/components/ui/metric";

describe("Panel", () => {
  it("reflects its visual state via data-state", () => {
    const { container } = render(<Panel state="attention">x</Panel>);
    expect(container.querySelector("[data-state='attention']")).not.toBeNull();
  });

  it("defaults to the ambient state", () => {
    const { container } = render(<Panel>x</Panel>);
    expect(container.querySelector("[data-state='ambient']")).not.toBeNull();
  });

  it("renders a header title as an accessible heading", () => {
    render(<PanelHeader title="Storage" id="s" />);
    expect(
      screen.getByRole("heading", { name: "Storage" }),
    ).toBeInTheDocument();
  });
});

describe("Metric", () => {
  it("renders value, unit, and label", () => {
    render(<Metric value="86" unit="%" label="capacity" />);
    expect(screen.getByText("86")).toBeInTheDocument();
    expect(screen.getByText("%")).toBeInTheDocument();
    expect(screen.getByText("capacity")).toBeInTheDocument();
  });
});
