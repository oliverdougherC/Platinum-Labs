import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KineticApp } from "@/components/kinetic/kinetic-app";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

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
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
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

afterEach(cleanup);

function props(scenario: Parameters<typeof makeFakeSnapshot>[0]) {
  return {
    snapshot: makeFakeSnapshot(scenario, NOW),
    now: NOW,
    seerrConfigured: true,
    frozen: false,
    devControls: false,
  };
}

describe("KineticApp retained topology", () => {
  it("keeps the last-known workload population as explicit unknowns when Docker drops out", () => {
    const { container, rerender } = render(<KineticApp {...props("container-field-real")} />);
    const populated = container.querySelectorAll("[data-kinetic-cell]").length;
    expect(populated).toBeGreaterThan(30);
    expect(container.textContent).toMatch(/\d+ \/ \d+ containers running/);

    rerender(<KineticApp {...props("docker-unavailable")} />);
    // Identity is retained — the field does not vanish…
    expect(container.querySelectorAll("[data-kinetic-cell]").length).toBe(populated);
    // …but no live workload count is asserted while telemetry is unavailable.
    expect(container.textContent).not.toMatch(/containers running/);
  });

  it("starts explicitly incomplete on a cold start without any Docker inventory", () => {
    const { container } = render(<KineticApp {...props("docker-unavailable")} />);
    expect(container.querySelectorAll("[data-kinetic-cell]").length).toBe(0);
    expect(container.textContent).not.toMatch(/containers running/);
  });
});
