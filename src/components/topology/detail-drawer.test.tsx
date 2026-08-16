import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DetailDrawer } from "@/components/topology/detail-drawer";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

afterEach(cleanup);

describe("DetailDrawer", () => {
  it("does not substitute unrelated global events for an inactive service", () => {
    const snapshot = makeFakeSnapshot("active", 1_754_000_000_000);
    snapshot.activity = snapshot.activity.filter((event) => event.source !== "jellyfin");

    render(
      <DetailDrawer
        selection={{ kind: "service", id: "jellyfin" }}
        snapshot={snapshot}
        now={1_754_000_000_000}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("No recent activity.")).toBeInTheDocument();
  });

  it("shows Jellyfin container telemetry only via the exact configured mapping", () => {
    const snapshot = makeFakeSnapshot("active", 1_754_000_000_000);
    expect(snapshot.jellyfinContainer).toBe("jellyfin");
    render(
      <DetailDrawer
        selection={{ kind: "service", id: "jellyfin" }}
        snapshot={snapshot}
        now={1_754_000_000_000}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Container")).toBeInTheDocument();
  });

  it("never selects a similarly named container by substring", () => {
    const snapshot = makeFakeSnapshot("active", 1_754_000_000_000);
    // No explicit mapping + an exporter sidecar whose name CONTAINS the id:
    // the drawer must not impersonate the service with the sidecar's stats.
    snapshot.jellyfinContainer = null;
    const docker = snapshot.telemetry.docker.value!;
    docker.containers = docker.containers.map((c) =>
      c.name === "jellyfin" ? { ...c, name: "jellyfin-exporter" } : c,
    );
    render(
      <DetailDrawer
        selection={{ kind: "service", id: "jellyfin" }}
        snapshot={snapshot}
        now={1_754_000_000_000}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("Container")).not.toBeInTheDocument();
  });

  it("services without an explicit mapping omit container telemetry entirely", () => {
    const snapshot = makeFakeSnapshot("active", 1_754_000_000_000);
    // A container literally named "sonarr" exists in the fixture, but there
    // is no operator-declared mapping for Sonarr — so no container section.
    render(
      <DetailDrawer
        selection={{ kind: "service", id: "sonarr" }}
        snapshot={snapshot}
        now={1_754_000_000_000}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("Container")).not.toBeInTheDocument();
    expect(screen.getByText("Queue")).toBeInTheDocument();
  });

  it("does not mount a closed drawer", () => {
    render(
      <DetailDrawer
        selection={null}
        snapshot={makeFakeSnapshot("idle")}
        now={1_754_000_000_000}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
