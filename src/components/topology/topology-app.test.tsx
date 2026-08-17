import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.queryByText(/updated just now|updated|frozen/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
    // …and the observatory control exposes a compact count with full semantics.
    expect(
      screen.getByRole("button", { name: /notifications: 1 active, critical/i }),
    ).toBeInTheDocument();
  });

  it("renders one accessible source-owned observatory control cluster", () => {
    const snapshot = makeFakeSnapshot("idle", NOW);
    render(
      <TopologyApp
        initial={snapshot}
        seerr={{ search: true, requests: true }}
        quickLinks={[]}
        uiMode="fabric"
        frozen
      />,
    );
    const cluster = screen.getByRole("group", { name: "Observatory controls" });
    const request = screen.getByRole("button", { name: "Request media" });
    const commands = screen.getByRole("button", { name: "Search and commands" });
    const notifications = screen.getByRole("button", { name: /Notifications: quiet/ });
    expect(cluster).toContainElement(request);
    expect(cluster).toContainElement(commands);
    expect(cluster).toContainElement(notifications);
    expect(request).toHaveClass("h-10");
    expect(request.querySelector("svg")).not.toBeNull();
    expect(cluster).not.toHaveTextContent("⌕");
    expect(screen.getByRole("group", { name: /Server fabric/ })).toBeInTheDocument();
    expect(screen.getByText("DataStore")).toBeInTheDocument();
  });

  it("keeps notifications, drawers, and media search mutually exclusive", () => {
    const snapshot = makeFakeSnapshot("idle", NOW);
    render(
      <TopologyApp
        initial={snapshot}
        seerr={{ search: true, requests: true }}
        quickLinks={[]}
        frozen
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Request media" }));
    expect(screen.getByRole("dialog", { name: "Media search" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Notifications: quiet/i }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Media search" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Jellyfin detail" }));
    expect(screen.getByRole("dialog", { name: "Jellyfin" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Media search" })).not.toBeInTheDocument();
  });
});

describe("flow technical detail interaction (V2.1 evidence display)", () => {
  it("activating a flow target opens the shared flow-detail drawer with full evidence", () => {
    renderApp("transcode");
    // Flow targets are native <button>s, so click and Enter share the same
    // native activation path; the test focuses first to model keyboard use.
    const flowTarget = screen.getByRole("button", { name: /^Jellyfin → network/ });
    expect(flowTarget).toHaveAttribute("aria-haspopup", "dialog");
    act(() => flowTarget.focus());
    fireEvent.click(flowTarget);

    const dialog = screen.getByRole("dialog", { name: /Flow · Jellyfin → network/ });
    // The compact technical surface: endpoints, headline, evidence, basis,
    // coverage, freshness, provenance.
    expect(within(dialog).getByText("Path")).toBeInTheDocument();
    expect(within(dialog).getByText("Headline")).toBeInTheDocument();
    expect(within(dialog).getByText("Coverage")).toBeInTheDocument();
    expect(within(dialog).getByText("Basis")).toBeInTheDocument();
    expect(within(dialog).getByText("Path evidence")).toBeInTheDocument();
    expect(within(dialog).getByText("Freshness")).toBeInTheDocument();
    expect(within(dialog).getByText("Source updated")).toBeInTheDocument();
  });

  it("Escape closes the flow detail and focus returns to the flow target", () => {
    renderApp("transcode");
    const flowTarget = screen.getByRole("button", { name: /^Jellyfin → network/ });
    act(() => flowTarget.focus());
    fireEvent.click(flowTarget);
    expect(
      screen.getByRole("dialog", { name: /Flow · Jellyfin → network/ }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: /Flow · Jellyfin → network/ }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(flowTarget);
  });

  it("retained non-headline observations render in the detail surface", () => {
    // direct-play with a zero container window: the session aggregate is the
    // headline and the measured zero is retained under "Also observed".
    const snapshot = makeFakeSnapshot("direct-play", NOW);
    const docker = snapshot.telemetry.docker.value!;
    docker.containers = docker.containers.map((c) =>
      c.name === "jellyfin" ? { ...c, netTxBps: 0, blockReadBps: 0 } : c,
    );
    render(
      <TopologyApp
        initial={snapshot}
        seerr={{ search: false, requests: false }}
        quickLinks={[]}
        frozen
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Jellyfin → network/ }));
    const dialog = screen.getByRole("dialog", { name: /Flow · Jellyfin → network/ });
    expect(within(dialog).getByText("Also observed")).toBeInTheDocument();
    expect(within(dialog).getByText("container-egress")).toBeInTheDocument();
    expect(within(dialog).getByText(/0\.0? ?B\/s|0 B\/s/)).toBeInTheDocument();
  });

  it("a flow that stopped being observed reads honestly instead of rendering stale evidence", () => {
    const snapshot = makeFakeSnapshot("idle", NOW);
    render(
      <TopologyApp
        initial={snapshot}
        seerr={{ search: false, requests: false }}
        quickLinks={[]}
        frozen
        initialPanels={{ drawer: "flow:egress:jellyfin->network" }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Flow" });
    expect(
      within(dialog).getByText(/not observed in the latest snapshot/),
    ).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: /jellyfin container detail/i }),
    ).toBeInTheDocument();
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
      screen.getByRole("button", { name: /network → qBittorrent.*stale/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("stale").length).toBeGreaterThan(0);
  });
});

describe("metrics rail — missing telemetry is never zero", () => {
  it("unconfigured host telemetry shows an explicit status, not 0", () => {
    const snapshot = makeFakeSnapshot("unconfigured", NOW);
    render(<MetricsRail snapshot={snapshot} />);
    expect(screen.getAllByText(/not set up/)).toHaveLength(4);
    expect(screen.queryByText(/^0%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 B\/s/)).not.toBeInTheDocument();
  });

  it("keeps the strongest four signals visible and moves secondary detail out", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    render(<MetricsRail snapshot={snapshot} />);
    const horizon = screen.getByRole("contentinfo", { name: "Live telemetry" });
    expect(horizon).toHaveTextContent("cpu");
    expect(horizon).toHaveTextContent("mem");
    expect(horizon).toHaveTextContent("net");
    expect(horizon).toHaveTextContent("disk");
    expect(horizon).not.toHaveTextContent("docker");
    expect(horizon).not.toHaveTextContent("arc");
  });

  it("reflows into a compact two-column rail before the wide horizon breakpoint", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const { container } = render(<MetricsRail snapshot={snapshot} />);
    expect(container.querySelector("footer")).toHaveClass("grid-cols-2", "sm:grid-cols-4");
  });
});
