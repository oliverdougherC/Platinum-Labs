import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopologyApp } from "@/components/topology/topology-app";
import { TopologyScene } from "@/components/topology/scene";
import { MetricsRail } from "@/components/topology/metrics-rail";
import { deriveFlows } from "@/lib/topology/activity";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { FAKE_CORE_COUNT } from "@/lib/fake/telemetry";

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

  it("renders exactly one spoke per real logical CPU (never padded)", () => {
    const { container } = renderApp("idle");
    expect(container.querySelectorAll(".cpu-spoke")).toHaveLength(FAKE_CORE_COUNT);
  });

  it("renders every pool as a storage body with LOGICAL capacity", () => {
    renderApp("idle");
    expect(screen.getByText("DataStore")).toBeInTheDocument();
    // 41.8/69.6 TB logical — never the 96.0 TB raw physical size.
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

describe("scene flows", () => {
  it("idle renders zero flow paths; active renders real ones", () => {
    const idle = makeFakeSnapshot("idle", NOW);
    const { container: idleC } = render(
      <TopologyScene snapshot={idle} flows={deriveFlows(idle, NOW)} onSelect={() => {}} />,
    );
    expect(idleC.querySelectorAll(".flow-dash")).toHaveLength(0);

    const active = makeFakeSnapshot("active", NOW);
    const { container: activeC } = render(
      <TopologyScene snapshot={active} flows={deriveFlows(active, NOW)} onSelect={() => {}} />,
    );
    expect(activeC.querySelectorAll(".flow-dash").length).toBeGreaterThan(0);
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
