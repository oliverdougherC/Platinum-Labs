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
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("No recent activity.")).toBeInTheDocument();
  });

  it("does not mount a closed drawer", () => {
    render(<DetailDrawer selection={null} snapshot={makeFakeSnapshot("idle")} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
