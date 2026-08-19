import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FabricCompositionStudy, resolveStudyRelationshipState } from "@/components/dev/fabric-composition-study";
import {
  buildFabricModel,
  buildFabricTopologyInventory,
  type FabricRelationship,
} from "@/lib/fabric/model";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = Date.UTC(2026, 7, 15, 12);

afterEach(() => {
  cleanup();
});

describe("FabricCompositionStudy", () => {
  it("uses explicit relationship-map view mode instead of inferring from scenario naming", () => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="idle"
        initialViewMode="relationship-map"
        now={NOW}
        initialFocus={null}
      />,
    );

    expect(container.querySelector("[data-study-shell]")).toHaveAttribute("data-study-view-mode", "relationship-map");
    const declaredRoutes = [...container.querySelectorAll('[data-study-logical-route^="declared:"]')];

    expect(declaredRoutes.length).toBeGreaterThan(0);
    expect(declaredRoutes.every((route) => route.getAttribute("data-study-route-motion") === "static")).toBe(true);
    expect(container.querySelector('[data-study-logical-route^="declared:"][data-study-route-visible="true"][data-study-route-motion="static"]')).not.toBeNull();
    for (const [from, to] of [
      ["service:seerr", "service:sonarr"],
      ["service:seerr", "service:radarr"],
      ["service:sonarr", "service:qbittorrent"],
      ["service:sonarr", "service:jellyfin"],
      ["fabric:service", "service:seerr"],
    ]) {
      expect(container.querySelector(`[data-study-route-from="${from}"][data-study-route-to="${to}"][data-study-route-visible="true"]`)).not.toBeNull();
    }
  });

  it("keeps focused relationship-map routes constrained to declared and control relationships", () => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="downloads"
        initialViewMode="relationship-map"
        now={NOW}
        initialFocus="service:sonarr"
      />,
    );

    expect(container.querySelector('[data-study-route-plane="data"][data-study-route-visible="true"]')).toBeNull();
    expect(container.querySelector('[data-study-route-plane="control"][data-study-route-visible="true"]')).not.toBeNull();
  });

  it("progressively reveals ordinary ports only when the node is focused", () => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="idle"
        initialViewMode="activity"
        now={NOW}
        initialFocus={null}
      />,
    );

    expect(container.querySelector('[data-study-port-id="service:sonarr:control"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Sonarr;/ }));

    expect(container.querySelector('[data-study-port-id="service:sonarr:control"]')).not.toBeNull();
  });

  it.each([
    ["downloads", "live-transfer"],
    ["stale", "stale"],
  ] as const)("surfaces %s route activity as %s", (scenario, expectedState) => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario={scenario}
        initialViewMode="activity"
        now={NOW}
        initialFocus={null}
      />,
    );

    expect(container.querySelector(`[data-study-logical-route][data-study-route-activity="${expectedState}"]`)).not.toBeNull();
  });

  it("keeps dormant structural substrate distinguishable from zero-byte routes", () => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="idle"
        initialViewMode="activity"
        now={NOW}
        initialFocus={null}
      />,
    );

    expect(container.querySelector('[data-study-segment-activity="dormant-structural"]')).not.toBeNull();
  });

  it("keeps docker-unavailable telemetry unavailable while falling back to inventory topology", () => {
    const unavailableSnapshot = makeFakeSnapshot("docker-unavailable", NOW);
    const inventory = buildFabricTopologyInventory(makeFakeSnapshot("container-field-real", NOW));
    const model = buildFabricModel(unavailableSnapshot, {
      now: NOW,
      seerrConfigured: true,
      networkBoundaries: ["wan", "lan", "overlay"],
      inventory,
    });

    expect(unavailableSnapshot.telemetry.docker.status).toBe("unavailable");
    expect(unavailableSnapshot.telemetry.docker.value).toBeNull();
    expect(model.population.total).toBeNull();
    expect(model.population.running).toBeNull();
    expect(model.population.represented).toBe(44);
    expect(model.population.groups.length).toBeGreaterThan(0);
    expect(model.population.groups.some((group) => group.id === "group:platform")).toBe(true);
    expect(model.population.ids.length).toBeGreaterThan(0);

    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="docker-unavailable"
        initialViewMode="activity"
        now={NOW}
        initialFocus={null}
      />,
    );

    expect(container.querySelector('[data-study-node="group:platform"]')).not.toBeNull();
    expect(container.querySelector('[data-study-node="resource:cpu"]')).not.toBeNull();
  });

  it("explains subsystem resource and network connectivity without inventing storage", () => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="container-field-real"
        initialViewMode="activity"
        now={NOW}
        initialFocus="group:media-support"
      />,
    );

    expect(container.querySelector('[data-study-node="resource:cpu"] .fabric-study-resource-selected')).not.toBeNull();
    expect(container.querySelector('[data-study-node="resource:memory"] .fabric-study-resource-selected')).not.toBeNull();
    expect(container.querySelector('[data-study-node="group:media-support"]')).toHaveAttribute("data-study-member-ids");
    expect(container.querySelector("[data-study-focus-connectivity]")?.textContent).toContain("3 network memberships");
    expect(container.querySelector("[data-study-focus-connectivity]")?.textContent).toContain("storage capability unknown");
  });

  it("exposes confirmed-zero as the dominant rendered data-plane state", () => {
    const { container } = render(
      <FabricCompositionStudy
        study="A+"
        initialScenario="confirmed-zero"
        initialViewMode="activity"
        now={NOW}
        initialFocus={null}
      />,
    );

    const shell = container.querySelector("[data-study-shell]");
    expect(shell).toHaveAttribute("data-study-rendered-activity", "confirmed-zero");
    expect(shell).toHaveAttribute("data-study-activity-scope", "data-plane");
    expect(container.querySelector('[data-study-route-activity="confirmed-zero"]')).not.toBeNull();
    expect(container.querySelector('[data-study-route-motion="directional"][data-study-route-activity="confirmed-zero"]')).toBeNull();
  });

  it("resolves all non-visualized relationship activity states explicitly", () => {
    const base = {
      id: "synthetic",
      label: "Synthetic",
      plane: "data",
      evidence: "derived",
      freshness: "live",
      coverage: "complete",
      fromNodeId: "service:sonarr",
      toNodeId: "service:jellyfin",
      fromPortId: "service:sonarr:read",
      toPortId: "service:jellyfin:read",
      rateBytesPerSecond: 1,
      width: 1,
      direction: "forward",
      tone: "in",
      animated: true,
      visibility: "active",
      provenance: "test",
      basis: null,
      attribution: null,
      networkBoundary: "docker-internal",
      route: {
        fromPortId: "service:sonarr:read",
        toPortId: "service:jellyfin:read",
        points: [],
        path: "",
        laneIds: [],
        segments: [],
        junctions: [],
      },
    } satisfies Partial<FabricRelationship>;
    const relationship = (overrides: Record<string, unknown>) => ({ ...base, ...overrides }) as unknown as FabricRelationship;

    expect(resolveStudyRelationshipState(relationship({ rateBytesPerSecond: null }))).toBe("unknown");
    expect(resolveStudyRelationshipState(relationship({ rateBytesPerSecond: 0, animated: false }))).toBe("confirmed-zero");
    expect(resolveStudyRelationshipState(relationship({ visibility: "focus", plane: "control", rateBytesPerSecond: null, animated: false }))).toBe("live-state-only");
    expect(resolveStudyRelationshipState(relationship({ freshness: "stale", rateBytesPerSecond: 10, animated: false }))).toBe("stale");
    expect(resolveStudyRelationshipState(relationship({ renderedActivity: "dormant" }))).toBe("dormant-structural");
  });
});
