import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { MediaModule } from "@/components/modules/media-module";
import { StorageModule } from "@/components/modules/storage-module";
import { ActivityFeed } from "@/components/modules/activity-feed";
import { AttentionSummary } from "@/components/modules/attention-summary";
import type { ConnectorId, DashboardSnapshot } from "@/lib/types";

const NOW = 1_754_000_000_000;

/** Override the health record for one connector on a fake snapshot. */
function withHealth(
  snapshot: DashboardSnapshot,
  id: ConnectorId,
  over: Partial<DashboardSnapshot["health"][number]>,
): DashboardSnapshot {
  return {
    ...snapshot,
    health: snapshot.health.map((h) => (h.id === id ? { ...h, ...over } : h)),
  };
}

describe("MediaModule — idle vs unavailable vs unconfigured look different", () => {
  it("idle: 'Nobody is watching'", () => {
    render(<MediaModule snapshot={makeFakeSnapshot("idle", NOW)} now={NOW} />);
    expect(screen.getByText("Nobody is watching.")).toBeInTheDocument();
  });

  it("unavailable: 'Jellyfin is unreachable'", () => {
    render(
      <MediaModule
        snapshot={makeFakeSnapshot("connector-unavailable", NOW)}
        now={NOW}
      />,
    );
    expect(screen.getByText("Jellyfin is unreachable.")).toBeInTheDocument();
  });

  it("unconfigured: 'Jellyfin is not configured'", () => {
    render(
      <MediaModule snapshot={makeFakeSnapshot("unconfigured", NOW)} now={NOW} />,
    );
    expect(screen.getByText("Jellyfin is not configured.")).toBeInTheDocument();
  });

  it("transcode: session shows a Transcoding indicator", () => {
    render(
      <MediaModule snapshot={makeFakeSnapshot("transcode", NOW)} now={NOW} />,
    );
    expect(screen.getAllByText("Transcoding").length).toBeGreaterThan(0);
  });

  it("multi-session: renders more than one session title", () => {
    render(
      <MediaModule snapshot={makeFakeSnapshot("multi-session", NOW)} now={NOW} />,
    );
    // two distinct titles from the fixture
    expect(screen.getByText("Dune: Part Two")).toBeInTheDocument();
    expect(screen.getByText(/Andor/)).toBeInTheDocument();
  });
});

describe("StorageModule — truthful empty states (PLA-194)", () => {
  it("unconfigured: 'Storage is not configured'", () => {
    render(
      <StorageModule snapshot={makeFakeSnapshot("unconfigured", NOW)} now={NOW} />,
    );
    expect(screen.getByText("Storage is not configured.")).toBeInTheDocument();
  });

  it("configured but unavailable + zero pools: 'unavailable', NOT 'not configured'", () => {
    const base = makeFakeSnapshot("idle", NOW);
    const snap = withHealth(
      { ...base, zfs: { pools: [] } },
      "zfs",
      { status: "unavailable", configured: true, lastSuccessAt: NOW - 10 * 60_000 },
    );
    render(<StorageModule snapshot={snap} now={NOW} />);
    expect(screen.getByText("Storage data is unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/not configured/)).not.toBeInTheDocument();
  });

  it("healthy but genuinely empty: 'No pools reported'", () => {
    const base = makeFakeSnapshot("idle", NOW);
    const snap = { ...base, zfs: { pools: [] } }; // zfs health stays healthy
    render(<StorageModule snapshot={snap} now={NOW} />);
    expect(screen.getByText("No pools reported.")).toBeInTheDocument();
  });

  it("degraded pool: surfaces the DEGRADED health label", () => {
    render(
      <StorageModule snapshot={makeFakeSnapshot("zfs-degraded", NOW)} now={NOW} />,
    );
    expect(screen.getByText("DEGRADED")).toBeInTheDocument();
  });
});

describe("StorageModule — 30-day trend chart (PLA-188)", () => {
  it("renders the real 30-day trend when enough history exists", () => {
    // The idle fixture carries a 30-day storage history for both pools.
    render(<StorageModule snapshot={makeFakeSnapshot("idle", NOW)} now={NOW} />);
    expect(screen.getByText("Used capacity · 30d")).toBeInTheDocument();
    // Pools remain the primary surface: "tank" appears both as a capacity row and
    // as a distinguishable chart-series legend label.
    expect(screen.getAllByText("tank").length).toBeGreaterThanOrEqual(2);
  });

  it("omits the trend chart on a fresh install without meaningful history", () => {
    const base = makeFakeSnapshot("idle", NOW);
    const snap: DashboardSnapshot = {
      ...base,
      history: { throughput: [], storageSeries: base.history?.storageSeries ?? [], storage: [] },
    };
    render(<StorageModule snapshot={snap} now={NOW} />);
    expect(screen.queryByText("Used capacity · 30d")).not.toBeInTheDocument();
    // Current capacity still shows — the module never pretends history exists.
    expect(screen.getByText("tank")).toBeInTheDocument();
  });
});

describe("MediaModule — truthful acquisition empty state (PLA-194)", () => {
  it("healthy + empty queue: 'Acquisition queue is clear'", () => {
    render(<MediaModule snapshot={makeFakeSnapshot("idle", NOW)} now={NOW} />);
    expect(screen.getByText("Acquisition queue is clear.")).toBeInTheDocument();
  });

  it("a source unavailable + empty queue: does NOT claim the queue is clear", () => {
    const base = makeFakeSnapshot("idle", NOW); // acquisition is empty
    const snap = withHealth(base, "sonarr", {
      status: "unavailable",
      configured: true,
      lastSuccessAt: NOW - 10 * 60_000,
    });
    render(<MediaModule snapshot={snap} now={NOW} />);
    expect(
      screen.getByText(/Some download sources are unavailable/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Acquisition queue is clear.")).not.toBeInTheDocument();
  });

  it("no acquisition sources configured: 'No download sources are configured'", () => {
    let snap = makeFakeSnapshot("idle", NOW);
    for (const id of ["sonarr", "radarr", "qbittorrent"] as ConnectorId[]) {
      snap = withHealth(snap, id, { configured: false, status: "unavailable", lastSuccessAt: null });
    }
    render(<MediaModule snapshot={snap} now={NOW} />);
    expect(
      screen.getByText("No download sources are configured."),
    ).toBeInTheDocument();
  });
});

describe("ActivityFeed — truthful empty vs unavailable (PLA-194)", () => {
  it("read succeeded but empty: 'Nothing has happened recently'", () => {
    const base = makeFakeSnapshot("idle", NOW);
    const snap = { ...base, activity: [], activityAvailable: true };
    render(<ActivityFeed snapshot={snap} now={NOW} />);
    expect(screen.getByText("Nothing has happened recently.")).toBeInTheDocument();
  });

  it("read failed: 'Activity history is unavailable', NOT 'nothing happened'", () => {
    const base = makeFakeSnapshot("idle", NOW);
    const snap = { ...base, activity: [], activityAvailable: false };
    render(<ActivityFeed snapshot={snap} now={NOW} />);
    expect(screen.getByText("Activity history is unavailable.")).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing has happened recently."),
    ).not.toBeInTheDocument();
  });
});

describe("AttentionSummary", () => {
  it("healthy: reassuring line", () => {
    render(<AttentionSummary snapshot={makeFakeSnapshot("idle", NOW)} now={NOW} />);
    expect(screen.getByText("Everything looks good.")).toBeInTheDocument();
  });

  it("attention: sorts critical before warning", () => {
    render(
      <AttentionSummary snapshot={makeFakeSnapshot("attention", NOW)} now={NOW} />,
    );
    const labels = screen.getAllByText(/Critical|Warning/);
    expect(labels[0]).toHaveTextContent("Critical");
  });
});
