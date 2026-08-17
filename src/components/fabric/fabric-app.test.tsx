import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FabricApp } from "@/components/fabric/fabric-app";
import { buildFabricModel } from "@/lib/fabric/model";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = Date.UTC(2026, 7, 15, 12);

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

describe("FabricApp", () => {
  it("keeps the healthy surface free of freshness chatter", () => {
    const { container } = render(
      <FabricApp
        snapshot={makeFakeSnapshot("idle", NOW)}
        now={NOW}
        seerrConfigured
        frozen={false}
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(screen.getByText("Server fabric")).toBeInTheDocument();
    expect(screen.queryByText(/updated|freshness|healthy|live/i)).not.toBeInTheDocument();
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("disables animated relationship scheduler attributes in frozen and reduced-motion modes", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const { container, rerender } = render(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen={false}
        reducedMotion={false}
        devControls={false}
      />,
    );

    expect(container.querySelectorAll('[data-fabric-flow-motion="true"]').length).toBeGreaterThan(0);

    rerender(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );
    expect(container.querySelectorAll('[data-fabric-flow-motion="true"]')).toHaveLength(0);

    rerender(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen={false}
        reducedMotion
        devControls={false}
      />,
    );
    expect(container.querySelectorAll('[data-fabric-flow-motion="true"]')).toHaveLength(0);
  });

  it("opens the inspector from keyboard selection and clears it on Escape", () => {
    render(
      <FabricApp
        snapshot={makeFakeSnapshot("active", NOW)}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    const jellyfin = screen.getByRole("button", { name: /^Jellyfin;/ });
    jellyfin.focus();
    fireEvent.keyDown(jellyfin, { key: "Enter" });

    expect(screen.getByLabelText("Jellyfin inspector")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Jellyfin inspector")).not.toBeInTheDocument();
  });

  it("exposes the complete grouped workload population in technical details", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const group = model.population.groups[0]!;

    render(
      <FabricApp
        snapshot={snapshot}
        now={NOW}
        seerrConfigured
        frozen
        reducedMotion={false}
        devControls={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${group.label};`) }));
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));

    const dialog = screen.getByRole("dialog", { name: "Fabric technical details" });
    const populationHeading = within(dialog).getByText(
      `Complete workload population · ${group.members.length}`,
    );
    const list = populationHeading.parentElement?.querySelector("ul");

    expect(list).not.toBeNull();
    expect(within(list!).getAllByRole("listitem")).toHaveLength(group.members.length);
    expect(within(dialog).getByText(group.members[0]!.name)).toBeInTheDocument();
    expect(within(dialog).getByText(group.members.at(-1)!.name)).toBeInTheDocument();
  });
});
