import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveShellTransportState,
  liveDataIsStale,
  useLiveData,
  type TransportObservation,
} from "@/components/topology/use-live-data";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = 1_754_000_000_000;

function transport(
  overrides: Partial<TransportObservation> = {},
): TransportObservation {
  return {
    lastSnapshotReceivedAt: NOW - 1_000,
    lastTelemetryReceivedAt: NOW - 1_000,
    lastSnapshotGeneratedAt: NOW - 1_000,
    lastTelemetryGeneratedAt: NOW - 1_000,
    sseState: "open",
    pollingState: "idle",
    lastFallbackSuccessAt: null,
    ...overrides,
  };
}

describe("live data freshness", () => {
  const now = 100_000;

  it("does not make an old server sample fresh when it arrives late", () => {
    expect(liveDataIsStale(now - 30_000, now - 100, now, false)).toBe(true);
  });

  it("detects a transport that stopped delivering otherwise-fresh samples", () => {
    expect(liveDataIsStale(now - 100, now - 30_000, now, false)).toBe(true);
  });

  it("accepts data only when both sample and receipt are fresh", () => {
    expect(liveDataIsStale(now - 100, now - 100, now, false)).toBe(false);
  });

  it("keeps deterministic frozen review frames out of live freshness gating", () => {
    expect(liveDataIsStale(0, 0, now, true)).toBe(false);
  });
});

describe("derived shell transport state", () => {
  it("is silent while snapshot and telemetry SSE are healthy", () => {
    expect(deriveShellTransportState(transport(), NOW, false)).toBe("healthy");
  });

  it("distinguishes retrying SSE with a live fallback", () => {
    expect(
      deriveShellTransportState(
        transport({ sseState: "retrying", lastFallbackSuccessAt: NOW - 500 }),
        NOW,
        false,
      ),
    ).toBe("reconnecting-with-fallback");
  });

  it("fresh telemetry cannot conceal a delayed full snapshot", () => {
    expect(
      deriveShellTransportState(
        transport({
          lastSnapshotReceivedAt: NOW - 30_000,
          lastSnapshotGeneratedAt: NOW - 30_000,
        }),
        NOW,
        false,
      ),
    ).toBe("data-delayed");
  });

  it("fresh snapshots cannot conceal a dead telemetry stream", () => {
    expect(
      deriveShellTransportState(
        transport({
          lastTelemetryReceivedAt: NOW - 30_000,
          lastTelemetryGeneratedAt: NOW - 30_000,
        }),
        NOW,
        false,
      ),
    ).toBe("data-delayed");
  });

  it("reports offline only after both SSE and fallback stop working", () => {
    expect(
      deriveShellTransportState(
        transport({
          sseState: "retrying",
          pollingState: "failed",
          lastSnapshotReceivedAt: NOW - 50_000,
          lastTelemetryReceivedAt: NOW - 50_000,
          lastSnapshotGeneratedAt: NOW - 50_000,
          lastTelemetryGeneratedAt: NOW - 50_000,
        }),
        NOW,
        false,
      ),
    ).toBe("offline");
  });
});

type Listener = (event: MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    const fn = listener as Listener;
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  emit(name: string, data: string) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data }));
    }
  }

  close() {
    this.closed = true;
  }
}

describe("useLiveData lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens one SSE source, accepts valid frames, and ignores malformed ones", () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const { result, unmount } = renderHook(() =>
      useLiveData(initial, { frozen: false }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());
    expect(result.current.transport.sseState).toBe("open");

    act(() => source.emit("snapshot", "not json"));
    act(() => source.emit("telemetry", "also not json"));
    expect(result.current.snapshot).toBe(initial);

    const next = makeFakeSnapshot("downloads", NOW + 1_000);
    act(() => source.emit("snapshot", JSON.stringify(next)));
    expect(result.current.snapshot.acquisition.rollup.downloading).toBeGreaterThan(0);
    unmount();
    expect(source.closed).toBe(true);
  });

  it("polls once on error and reports reconnecting with live fallback", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const next = makeFakeSnapshot("downloads", NOW + 1_000);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => next,
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.transport.shellState).toBe("reconnecting-with-fallback");
  });

  it("disconnects after the hidden grace and fetches unconditionally on resume", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => initial });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderHook(() => useLiveData(initial, { frozen: false }));
    const first = FakeEventSource.instances[0]!;

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(first.closed).toBe(true);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(FakeEventSource.instances[1]!.closed).toBe(true);
  });

  it("opens no transport in frozen mode", () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const { result } = renderHook(() => useLiveData(initial, { frozen: true }));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.transport.shellState).toBe("healthy");
  });
});
