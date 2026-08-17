import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { FabricInspector } from "@/components/fabric/fabric-inspector";
import { buildFabricModel } from "@/lib/fabric/model";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = Date.UTC(2026, 7, 15, 12);

afterEach(cleanup);

describe("FabricInspector", () => {
  it("keeps inspector content concise with one title, three metrics, and five relationships", () => {
    const model = buildFabricModel(makeFakeSnapshot("downloads", NOW), { now: NOW, seerrConfigured: true });
    const node = model.nodes.find((item) => item.id === "service:qbittorrent");

    expect(node).toBeDefined();

    node!.label = "qBittorrent";
    node!.metrics = [
      { label: "sessions", value: "9" },
      { label: "down", value: "112 MB/s" },
      { label: "up", value: "14 MB/s" },
      { label: "peers", value: "32" },
      { label: "queue", value: "120" },
    ];

    const template = model.relationships[0]!;
    model.relationships = Array.from({ length: 7 }, (_, index) => ({
      ...template,
      id: `relationship:${index}`,
      label: `Relationship ${index + 1}`,
      fromNodeId: node!.id,
    }));

    const { container } = render(
      <FabricInspector
        model={model}
        selection={{ kind: "node", id: node!.id }}
        onClose={() => {}}
        detailsOpen={false}
        onDetailsOpen={() => {}}
        onDetailsClose={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "qBittorrent" })).toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(3);

    const relationships = screen.getByRole("list", { name: "Relevant relationships" });
    expect(within(relationships).getAllByRole("listitem")).toHaveLength(5);
  });
});
