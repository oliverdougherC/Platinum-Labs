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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
  it("opens a compact active-download panel on qBittorrent hover and focus", () => {
    const snapshot = structuredClone(makeFakeSnapshot("downloads", NOW));
    snapshot.acquisition.items.push({
      id: "arr-only",
      source: "sonarr",
      title: "Uncorrelated usenet acquisition",
      quality: null,
      state: "downloading",
      progress: 0.4,
      rateBps: 900_000,
      etaSeconds: null,
      correlationKey: null,
    });
    const { container } = render(<KineticCanvas {...props(snapshot)} />);
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="qbittorrent"]',
    )!;

    expect(container.querySelector("[data-download-panel]")).toBeNull();
    fireEvent.mouseEnter(anchor);
    const panel = container.querySelector("[data-download-panel]")!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain("Severance — S02E07");
    expect(panel.textContent).toContain("63%");
    expect(panel.textContent).toContain("7.5 MB/s");
    expect(panel.textContent).toContain("Sinners (2025)");
    expect(panel.textContent).not.toContain("Shrinking — S02E10");
    expect(panel.textContent).not.toContain("Uncorrelated usenet acquisition");

    fireEvent.mouseLeave(anchor);
    fireEvent.mouseEnter(panel);
    expect(container.querySelector("[data-download-panel]")).toBe(panel);

    fireEvent.mouseLeave(panel);
    fireEvent.focus(anchor);
    expect(container.querySelector("[data-download-panel]")).not.toBeNull();
  });

  it("treats trigger and panel as one keyboard focus region without trapping focus", () => {
    vi.useFakeTimers();
    const { container } = render(
      <KineticCanvas {...props(makeFakeSnapshot("downloads", NOW))} />,
    );
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="qbittorrent"]',
    )!;

    act(() => anchor.focus());
    const panel = container.querySelector<HTMLElement>("[data-download-panel]")!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-labelledby")).toBe(
      "qbittorrent-download-panel-title",
    );
    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
    const list = panel.querySelector<HTMLElement>("[data-download-list]")!;
    expect(panel.querySelectorAll("li[data-download-row]")).toHaveLength(2);
    expect(list.tabIndex).toBe(0);

    fireEvent.keyDown(anchor, { key: "Tab" });
    expect(document.activeElement).toBe(list);
    act(() => vi.advanceTimersByTime(300));
    expect(container.querySelector("[data-download-panel]")).toBe(panel);

    fireEvent.keyDown(list, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(anchor);
    expect(fireEvent.keyDown(list, { key: "Tab" })).toBe(true);

    const outside = document.createElement("button");
    container.append(outside);
    fireEvent.blur(anchor, { relatedTarget: outside });
    act(() => vi.advanceTimersByTime(300));
    expect(container.querySelector("[data-download-panel]")).toBeNull();
  });

  it("keeps panel and row identity stable while live values update and input order changes", () => {
    const initial = structuredClone(makeFakeSnapshot("downloads", NOW));
    const { container, rerender } = render(<KineticCanvas {...props(initial)} />);
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="qbittorrent"]',
    )!;
    fireEvent.mouseEnter(anchor);
    const panel = container.querySelector("[data-download-panel]")!;
    const beforeRows = [...panel.querySelectorAll<HTMLElement>("[data-download-row]")];
    const beforeIds = beforeRows.map((row) => row.dataset.downloadRow);

    const next = structuredClone(initial);
    next.acquisition.items.reverse();
    const severance = next.acquisition.items.find((item) => item.id === "q-1")!;
    severance.progress = 0.71;
    severance.rateBps = 8_400_000;
    rerender(<KineticCanvas {...props(next)} />);

    const updatedPanel = container.querySelector("[data-download-panel]")!;
    const afterRows = [...updatedPanel.querySelectorAll<HTMLElement>("[data-download-row]")];
    expect(updatedPanel).toBe(panel);
    expect(afterRows.map((row) => row.dataset.downloadRow)).toEqual(beforeIds);
    for (let index = 0; index < beforeRows.length; index++) {
      expect(afterRows[index]).toBe(beforeRows[index]);
    }
    expect(updatedPanel.textContent).toContain("71%");
    expect(updatedPanel.textContent).toContain("8.4 MB/s");
  });

  it("focuses the actual scroll container for the deterministic long-download fixture", () => {
    const { container } = render(
      <KineticCanvas {...props(makeFakeSnapshot("downloads-many", NOW))} />,
    );
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="qbittorrent"]',
    )!;
    fireEvent.focus(anchor);
    const panel = container.querySelector("[data-download-panel]")!;
    expect(panel.querySelectorAll("[data-download-row]")).toHaveLength(12);
    const list = panel.querySelector<HTMLElement>("[data-download-list]")!;
    expect(list.className).toContain("max-h-");
    expect(list.className).toContain("overflow-y-auto");
    fireEvent.keyDown(anchor, { key: "Tab" });
    expect(document.activeElement).toBe(list);
    expect(fireEvent.keyDown(list, { key: "End" })).toBe(true);
    expect(fireEvent.keyDown(list, { key: "PageDown" })).toBe(true);
  });

  it("shows a quiet empty state instead of seeders or fabricated zero values", () => {
    const { container, rerender } = render(
      <KineticCanvas {...props(makeFakeSnapshot("seed-only", NOW))} />,
    );
    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="qbittorrent"]',
    )!;
    fireEvent.mouseEnter(anchor);
    let panel = container.querySelector("[data-download-panel]")!;
    expect(panel.textContent).toContain("No active downloads");
    expect(panel.querySelectorAll("[data-download-row]")).toHaveLength(0);

    rerender(<KineticCanvas {...props(makeFakeSnapshot("download-rate-unknown", NOW))} />);
    panel = container.querySelector("[data-download-panel]")!;
    expect(panel.textContent).toContain("—");
    expect(panel.textContent).not.toContain("0 B/s");
  });

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

  it("keeps active qBittorrent unknown-rate flows and copy visible without a zero claim", () => {
    const snapshot = makeFakeSnapshot("download-rate-unknown", NOW);
    const { container } = render(<KineticCanvas {...props(snapshot)} />);
    const flowList = container.querySelector('[aria-label="Active data flows"]')!;
    expect(flowList.textContent).toContain("WAN transfer — qBittorrent download · rate unknown");
    expect(flowList.textContent).toContain("staging I/O — download landing on storage · rate unknown");
    expect(flowList.textContent).not.toContain("0 B/s");

    const anchor = container.querySelector<HTMLButtonElement>(
      '[data-kinetic-anchor="qbittorrent"]',
    )!;
    expect(anchor.getAttribute("aria-label")).toContain("2 downloading");
    expect(anchor.getAttribute("aria-label")).not.toContain("B/s");
    fireEvent.click(anchor);
    const inspector = container.querySelector("[data-kinetic-inspector]")!;
    expect(inspector.textContent).toContain("rate unknown");
    expect(inspector.textContent).not.toContain("0 B/s");
  });

  it("exposes the live residual DataStore to eSATA copy on the rendered flow surface", () => {
    const snapshot = makeFakeSnapshot("background-copy-live-rollup", NOW);
    const { container } = render(<KineticCanvas {...props(snapshot)} />);
    const flowList = container.querySelector('[aria-label="Active data flows"]')!;
    expect(flowList.textContent).toContain(
      "background storage copy — background storage transfer · 39.5 MB/s",
    );
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
