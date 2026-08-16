import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { TopologyScene } from "@/components/topology/scene";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

/**
 * Regression: the scene clock must be CONTINUOUS across data updates.
 *
 * Every SSE event re-renders with a fresh snapshot/now, which gives
 * `drawFrame` a new identity and re-runs the render-loop effect. The bug
 * (fixed alongside this test): the animation epoch lived inside that effect,
 * so every stats ping rewound t to 0 and visibly restarted all
 * time-parameterized motion (star drift, breathing, particle phases).
 */

const renderedTs: number[] = [];

vi.mock("@/lib/scene/render", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scene/render")>();
  return {
    ...original,
    renderScene: vi.fn(
      (_ctx: unknown, _cam: unknown, state: { t: number }) => {
        renderedTs.push(state.t);
      },
    ),
  };
});

const NOW = 1_754_000_000_000;

let rafCb: FrameRequestCallback | null = null;

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom canvas has no 2d context; renderScene is mocked, so any object works.
  HTMLCanvasElement.prototype.getContext = (() =>
    ({}) as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Non-zero host rect so drawFrame doesn't early-return on size 0.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 450,
    top: 0,
    left: 0,
    right: 800,
    bottom: 450,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

beforeEach(() => {
  renderedTs.length = 0;
  rafCb = null;
});

afterEach(cleanup);

function sceneProps(atMs: number) {
  return {
    snapshot: makeFakeSnapshot("idle", atMs),
    now: atMs,
    seerrConfigured: false,
    frozen: false,
    reducedMotion: false,
    onSelect: () => {},
  };
}

function frame(ts: number) {
  act(() => {
    rafCb!(ts);
  });
}

describe("TopologyScene render loop", () => {
  it("keeps the scene clock continuous across data updates", () => {
    const view = render(<TopologyScene {...sceneProps(NOW)} />);

    // First frame establishes the epoch; the next advances t by 1s.
    frame(1_000);
    frame(2_000);
    expect(renderedTs).toEqual([0, 1]);

    // A stats ping: new snapshot + now → new drawFrame identity → the loop
    // effect re-runs. The clock must NOT rewind.
    view.rerender(<TopologyScene {...sceneProps(NOW + 2_000)} />);
    frame(3_000);
    expect(renderedTs).toEqual([0, 1, 2]);

    // And again — every subsequent update stays monotonic.
    view.rerender(<TopologyScene {...sceneProps(NOW + 4_000)} />);
    frame(4_000);
    expect(renderedTs).toEqual([0, 1, 2, 3]);
  });
});
