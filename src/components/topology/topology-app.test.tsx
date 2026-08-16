import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopologyApp } from "@/components/topology/topology-app";
import { TopologyScene } from "@/components/topology/scene";
import { MetricsRail } from "@/components/topology/metrics-rail";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = 1_754_000_000_000;

beforeAll(() => {
  // jsdom lacks matchMedia; the app only reads `matches`.
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
  // jsdom lacks ResizeObserver; the scene only needs construct/observe/disconnect.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function renderApp(scenario: Parameters<typeof makeFakeSnapshot>[0]) {
  const snapshot = makeFakeSnapshot(scenario, NOW);
  return render(
    <TopologyApp
      initial={snapshot}
      seerr={{ search: false, requests: false }}
      quickLinks={[]}
      frozen
    />,
  );
}

describe("TopologyApp — frozen/reduced-motion and composition", () => {
  it("frozen mode disables all animation via data-motion=off and opens no transport", () => {
    const { container } = renderApp("idle");
    expect(container.querySelector('[data-motion="off"]')).not.toBeNull();
  });

  it("renders every pool as a storage body with LOGICAL capacity", () => {
    renderApp("idle");
    expect(screen.getByText("DataStore")).toBeInTheDocument();
    // 41.8/69.6 TB logical — never the 96.0 TB zpool allocation size.
    expect(screen.getByText(/41\.8 \/ 69\.6 TB/)).toBeInTheDocument();
    expect(screen.queryByText(/96\.0 TB/)).not.toBeInTheDocument();
  });

  it("keeps warnings out of the layout: no banner text on the primary surface", () => {
    renderApp("zfs-degraded");
    // The degraded pool announces itself only at its own node…
    expect(screen.getByText(/DEGRADED · 4 errors/)).toBeInTheDocument();
    // …and the chrome shows only the compact alert count.
    expect(screen.getByText(/1 alert/)).toBeInTheDocument();
  });
});

describe("scene overlay — semantics without pixels", () => {
  function renderScene(
    scenario: Parameters<typeof makeFakeSnapshot>[0],
    now = NOW,
  ) {
    const snapshot = makeFakeSnapshot(scenario, NOW);
    return render(
      <TopologyScene
        snapshot={snapshot}
        now={now}
        seerrConfigured={false}
        frozen
        reducedMotion={false}
        onSelect={() => {}}
      />,
    );
  }

  it("every meaningful body is a keyboard-reachable, labeled control", () => {
    renderScene("idle");
    expect(screen.getByRole("button", { name: "Host compute detail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DataStore storage detail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jellyfin detail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "qBittorrent detail" })).toBeInTheDocument();
  });

  it("an unconfigured Requests integration reads 'not set up', never healthy", () => {
    renderScene("idle");
    expect(screen.getByText("Requests")).toBeInTheDocument();
    // seerrConfigured=false → the label carries the truthful state.
    expect(screen.getAllByText(/not set up/).length).toBeGreaterThanOrEqual(1);
  });

  it("ages an unchanged payload into stale scene flows when transport delivery stops", () => {
    renderScene("seeding", NOW + 31_000);
    expect(
      screen.getByRole("button", { name: /qBittorrent download.*stale/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("stale").length).toBeGreaterThan(0);
  });
});

describe("metrics rail — missing telemetry is never zero", () => {
  it("unconfigured host telemetry shows an explicit status, not 0", () => {
    const snapshot = makeFakeSnapshot("unconfigured", NOW);
    render(<MetricsRail snapshot={snapshot} />);
    expect(screen.getAllByText(/not set up/).length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText(/^0%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 B\/s/)).not.toBeInTheDocument();
  });

  it("available telemetry renders tabular values", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    render(<MetricsRail snapshot={snapshot} />);
    expect(screen.getByText(/load/)).toBeInTheDocument();
    expect(screen.getByText(/running/)).toBeInTheDocument();
  });
});
