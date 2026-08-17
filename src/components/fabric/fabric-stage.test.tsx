import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FabricStage, type FabricSelection } from "@/components/fabric/fabric-stage";
import { buildFabricModel } from "@/lib/fabric/model";
import { FABRIC_VIEWBOX } from "@/lib/fabric/layout";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = Date.UTC(2026, 7, 15, 12);

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

function StageHarness({
  scenario,
  relationshipsVisible = false,
  motionEnabled = false,
}: {
  scenario: Parameters<typeof makeFakeSnapshot>[0];
  relationshipsVisible?: boolean;
  motionEnabled?: boolean;
}) {
  const [selection, setSelection] = useState<FabricSelection | null>(null);
  const model = buildFabricModel(makeFakeSnapshot(scenario, NOW), { now: NOW, seerrConfigured: true });
  return (
    <FabricStage
      model={model}
      selection={selection}
      onSelect={setSelection}
      relationshipsVisible={relationshipsVisible}
      motionEnabled={motionEnabled}
    />
  );
}

describe("FabricStage", () => {
  it("preserves the normalized stage geometry when focus changes", () => {
    const { container } = render(<StageHarness scenario="active" />);

    const stage = screen.getByRole("group", { name: /Server fabric;/ });
    const nodeRect = container.querySelector('[data-fabric-node="service:jellyfin"] rect');

    expect(stage).toHaveAttribute("viewBox", `0 0 ${FABRIC_VIEWBOX.width} ${FABRIC_VIEWBOX.height}`);
    expect(nodeRect).not.toBeNull();

    const before = {
      x: nodeRect!.getAttribute("x"),
      y: nodeRect!.getAttribute("y"),
      width: nodeRect!.getAttribute("width"),
      height: nodeRect!.getAttribute("height"),
    };

    fireEvent.click(screen.getByRole("button", { name: /^Jellyfin;/ }));

    const focusedRect = container.querySelector('[data-fabric-node="service:jellyfin"] rect');
    expect(stage).toHaveAttribute("viewBox", `0 0 ${FABRIC_VIEWBOX.width} ${FABRIC_VIEWBOX.height}`);
    expect(focusedRect).toHaveAttribute("x", before.x);
    expect(focusedRect).toHaveAttribute("y", before.y);
    expect(focusedRect).toHaveAttribute("width", before.width);
    expect(focusedRect).toHaveAttribute("height", before.height);
  });

  it("renders declared relationship-map control links as static paths", () => {
    window.history.pushState({}, "", "/?relationships=1");
    const snapshot = makeFakeSnapshot("downloads", NOW);
    snapshot.fabricRelationships = [
      { from: "service:sonarr", to: "service:jellyfin", kind: "control", label: "library refresh" },
    ];
    const model = buildFabricModel(snapshot, { now: NOW, seerrConfigured: true });
    const { container } = render(
      <FabricStage
        model={model}
        selection={null}
        onSelect={() => {}}
        relationshipsVisible
        motionEnabled
      />,
    );

    const controlPath = container.querySelector('path[aria-label^="library refresh;"]');

    expect(controlPath).not.toBeNull();
    expect(controlPath).toHaveAttribute("stroke-dasharray", "3 7");
    expect(controlPath).not.toHaveAttribute("data-fabric-flow-motion", "true");
  });
});
