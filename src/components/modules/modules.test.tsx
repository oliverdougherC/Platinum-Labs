import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { MediaModule } from "@/components/modules/media-module";
import { StorageModule } from "@/components/modules/storage-module";
import { AttentionSummary } from "@/components/modules/attention-summary";

const NOW = 1_754_000_000_000;

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

describe("StorageModule", () => {
  it("unconfigured: 'No pools configured'", () => {
    render(
      <StorageModule snapshot={makeFakeSnapshot("unconfigured", NOW)} now={NOW} />,
    );
    expect(screen.getByText("No pools configured.")).toBeInTheDocument();
  });

  it("degraded: surfaces the DEGRADED health label", () => {
    render(
      <StorageModule snapshot={makeFakeSnapshot("zfs-degraded", NOW)} now={NOW} />,
    );
    expect(screen.getByText("DEGRADED")).toBeInTheDocument();
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
