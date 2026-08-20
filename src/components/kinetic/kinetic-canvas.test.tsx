import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { KineticCanvas } from "@/components/kinetic/kinetic-canvas";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * Component-level continuity contract (V4 release blocker): telemetry
 * updates rerender React with fresh snapshot/now identities, and the mounted
 * stage must ride through them — same DOM node, same single canvas, no
 * animation-loop duplication, focus stability.
 */

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

let rafCb: FrameRequestCallback | null = null;
let rafId = 0;

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCb = cb;
    rafId += 1;
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    rafCb = null;
  });
  // jsdom has no canvas 2d; the painter early-returns on a null context.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Non-zero stage size so the layout and overlay exist under jsdom.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 1600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 900;
    },
  });
});

beforeEach(() => {
  rafCb = null;
});

afterEach(cleanup);

function pumpFrames(count: number) {
  act(() => {
    for (let i = 0; i < count && rafCb; i++) {
      const cb = rafCb;
      rafCb = null;
      cb(performance.now());
    }
  });
}

function snapshotWithRate(bps: number): DashboardSnapshot {
  const snapshot = structuredClone(makeFakeSnapshot("downloads", NOW));
  snapshot.acquisition.rollup.aggregateRateBps = bps;
  return snapshot;
}

function props(snapshot: DashboardSnapshot, frozen = false) {
  return { snapshot, now: NOW, seerrConfigured: true, frozen };
}

describe("KineticCanvas continuity", () => {
  it("keeps the same mounted stage and single canvas across rate-changing snapshot updates", () => {
    const { container, rerender } = render(
      <KineticCanvas {...props(snapshotWithRate(10_000_000))} />,
    );
    const stage = container.querySelector("[data-kinetic-stage]");
    expect(stage).not.toBeNull();
    pumpFrames(4);
    expect(stage!.getAttribute("data-motion")).toBe("on");

    for (const bps of [40_000_000, 18_000_000, 65_000_000]) {
      rerender(<KineticCanvas {...props(snapshotWithRate(bps))} />);
      pumpFrames(3);
      // Same stage node, same single canvas — the update moved targets only.
      expect(container.querySelector("[data-kinetic-stage]")).toBe(stage);
      expect(container.querySelectorAll("canvas")).toHaveLength(1);
      expect(stage!.getAttribute("data-motion")).toBe("on");
    }
  });

  it("renders a frozen frame with no animation loop", () => {
    const { container } = render(
      <KineticCanvas {...props(snapshotWithRate(10_000_000), true)} />,
    );
    const stage = container.querySelector("[data-kinetic-stage]");
    expect(stage!.getAttribute("data-motion")).toBe("off");
    expect(rafCb).toBeNull();
  });

  it("gives the workload field one roving tab stop and arrow-key movement", () => {
    const snapshot = makeFakeSnapshot("container-field-real", NOW);
    const { container } = render(<KineticCanvas {...props(snapshot)} />);
    const cells = [...container.querySelectorAll<HTMLButtonElement>("[data-kinetic-cell]")];
    expect(cells.length).toBeGreaterThan(30);
    const tabbable = cells.filter((cell) => cell.tabIndex === 0);
    expect(tabbable).toHaveLength(1);

    act(() => tabbable[0]!.focus());
    fireEvent.keyDown(tabbable[0]!, { key: "ArrowRight" });
    const nextTabbable = [
      ...container.querySelectorAll<HTMLButtonElement>("[data-kinetic-cell]"),
    ].filter((cell) => cell.tabIndex === 0);
    expect(nextTabbable).toHaveLength(1);
    expect(nextTabbable[0]).not.toBe(tabbable[0]);
    expect(document.activeElement).toBe(nextTabbable[0]);
  });

  it("describes a partial known-zero flow as rate-unknown activity, never as 0 B/s", () => {
    const snapshot = makeFakeSnapshot("partial-zero", NOW);
    const { container } = render(<KineticCanvas {...props(snapshot)} />);
    // The accessible flow list keeps the activity visible without claiming an
    // authoritative zero: the total rate is unknown, not confirmed zero.
    const flowList = container.querySelector('[aria-label="Active data flows"]')!;
    expect(flowList.textContent).toContain("rate unknown");
    expect(flowList.textContent).not.toContain("0 B/s");
    // Jellyfin remains visibly active — playback is known to exist.
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="jellyfin"]',
    )!;
    expect(anchor.getAttribute("aria-label")).toContain("2 streams");
    // The inspector makes the same non-claim.
    fireEvent.click(anchor);
    const inspector = container.querySelector("[data-kinetic-inspector]")!;
    expect(inspector.textContent).toContain("rate unknown");
    expect(inspector.textContent).not.toContain("0 B/s");
  });

  it("restores focus to the initiating element when the inspector closes", () => {
    const snapshot = makeFakeSnapshot("active", NOW);
    const { container } = render(<KineticCanvas {...props(snapshot)} />);
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="jellyfin"]',
    )!;
    fireEvent.click(anchor);
    expect(container.querySelector("[data-kinetic-inspector]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector("[data-kinetic-inspector]")).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });
});
