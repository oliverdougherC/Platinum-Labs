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
    lastSseSnapshotAt: NOW - 1_000,
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

  it("fresh telemetry cannot conceal a delayed full snapshot (channels are independent)", () => {
    expect(
      deriveShellTransportState(
        transport({
          lastSnapshotReceivedAt: NOW - 30_000,
          lastSnapshotGeneratedAt: NOW - 30_000,
          lastSseSnapshotAt: NOW - 30_000,
        }),
        NOW,
        false,
      ),
    ).toBe("data-delayed");
  });

  it("a fresh full snapshot IS the documented lower-frequency telemetry fallback", () => {
    // Telemetry events died, but full snapshots (which contain the complete
    // telemetry payload) keep arriving: telemetry has merely degraded from
    // ~2s to snapshot cadence — healthy, by documented policy.
    expect(
      deriveShellTransportState(
        transport({
          lastTelemetryReceivedAt: NOW - 30_000,
          lastTelemetryGeneratedAt: NOW - 30_000,
        }),
        NOW,
        false,
      ),
    ).toBe("healthy");
    // Same when telemetry never delivered at all.
    expect(
      deriveShellTransportState(
        transport({ lastTelemetryReceivedAt: null, lastTelemetryGeneratedAt: null }),
        NOW,
        false,
      ),
    ).toBe("healthy");
  });

  it("snapshots arriving only via fallback are visibly degraded, not silently healthy", () => {
    expect(
      deriveShellTransportState(
        transport({
          // SSE claims open and telemetry is even flowing — but the SSE
          // snapshot channel is dead and the data is coming from polling.
          lastSseSnapshotAt: NOW - 30_000,
          lastFallbackSuccessAt: NOW - 2_000,
        }),
        NOW,
        false,
      ),
    ).toBe("reconnecting-with-fallback");
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
          lastSseSnapshotAt: NOW - 50_000,
        }),
        NOW,
        false,
      ),
    ).toBe("offline");
  });

  it("an EventSource stuck 'open' with no delivery and failed fallback goes offline", () => {
    // readyState is a claim, not delivery: nothing valid received on any
    // channel for the offline horizon derives offline even while `open`.
    expect(
      deriveShellTransportState(
        transport({
          sseState: "open",
          pollingState: "failed",
          lastSnapshotReceivedAt: NOW - 50_000,
          lastTelemetryReceivedAt: NOW - 50_000,
          lastSnapshotGeneratedAt: NOW - 50_000,
          lastTelemetryGeneratedAt: NOW - 50_000,
          lastSseSnapshotAt: NOW - 50_000,
        }),
        NOW,
        false,
      ),
    ).toBe("offline");
  });

  it("a 'connecting' source that never delivers, with failed fallback, goes offline", () => {
    expect(
      deriveShellTransportState(
        transport({
          sseState: "connecting",
          pollingState: "failed",
          lastSnapshotReceivedAt: NOW - 50_000,
          lastTelemetryReceivedAt: null,
          lastSnapshotGeneratedAt: NOW - 50_000,
          lastTelemetryGeneratedAt: null,
          lastSseSnapshotAt: null,
        }),
        NOW,
        false,
      ),
    ).toBe("offline");
  });

  it("telemetry-event recovery restores high-frequency health once snapshots are fresh via SSE", () => {
    expect(
      deriveShellTransportState(
        transport({
          lastTelemetryReceivedAt: NOW - 500,
          lastTelemetryGeneratedAt: NOW - 500,
        }),
        NOW,
        false,
      ),
    ).toBe("healthy");
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

describe("useLiveData self-healing fallback", () => {
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

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  /** Advance fake time in watchdog-sized steps, flushing microtasks between. */
  const advance = async (ms: number, step = 1_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await act(async () => {
        vi.advanceTimersByTime(Math.min(step, ms - elapsed));
        await flush();
      });
    }
  };

  function okFetch(payload: unknown) {
    return vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  }

  it("starts fallback when SSE reports open but never delivers an event", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = okFetch(makeFakeSnapshot("idle", NOW + 1));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());
    expect(result.current.transport.sseState).toBe("open");

    await advance(21_000);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.transport.pollingState).toBe("active");
    expect(result.current.transport.lastFallbackSuccessAt).not.toBeNull();
  });

  it("keeps polling through a heartbeat-only stream of malformed frames", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = okFetch(makeFakeSnapshot("idle", NOW + 1));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());

    await advance(21_000);
    const callsWhenFallbackStarted = fetchMock.mock.calls.length;
    expect(callsWhenFallbackStarted).toBeGreaterThan(0);

    // Heartbeats / malformed frames are NOT delivery: fallback keeps running.
    act(() => source.emit("snapshot", "not json"));
    act(() => source.emit("telemetry", "{broken"));
    await advance(14_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhenFallbackStarted);
    expect(result.current.transport.pollingState).toBe("active");
  });

  it("stops fallback only after a valid frame is parsed and applied", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = okFetch(makeFakeSnapshot("idle", NOW + 1));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());
    await advance(21_000);
    expect(result.current.transport.pollingState).toBe("active");

    // Valid SSE delivery resumes → fallback stands down…
    const next = makeFakeSnapshot("downloads", NOW + 25_000);
    act(() => source.emit("snapshot", JSON.stringify(next)));
    expect(result.current.transport.pollingState).toBe("idle");

    // …and stays down while frames keep arriving.
    const before = fetchMock.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      await advance(5_000);
      act(() =>
        source.emit("snapshot", JSON.stringify(makeFakeSnapshot("downloads", NOW + 30_000 + i))),
      );
    }
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("times out a slow fallback request instead of letting calls overlap", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const aborts: number[] = [];
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            aborts.push(Date.now());
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The bounded deadline (6s) fires before the next interval tick (7s):
    // the slow request fails cleanly and the next tick starts fresh.
    await advance(6_500);
    expect(aborts).toHaveLength(1);
    expect(result.current.transport.pollingState).toBe("failed");
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never overlaps fallback calls while one is in flight", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    // A pathological fetch that ignores abort and never settles: the
    // in-flight guard alone must prevent a second concurrent request.
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      await flush();
    });
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tears down cleanly with a fallback request in flight", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    let aborted = false;
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(aborted).toBe(true);
    expect(source.closed).toBe(true);
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeated SSE errors never create duplicate polling loops", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = okFetch(makeFakeSnapshot("idle", NOW + 1));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      source.onerror?.();
      source.onerror?.();
      await flush();
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(7_500);
    // One interval loop: exactly one more call after one interval elapses.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("telemetry-only delivery does not stand down snapshot fallback", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = okFetch(makeFakeSnapshot("idle", NOW + 1));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());

    const telemetryFrame = (at: number) =>
      JSON.stringify({
        telemetry: initial.telemetry,
        history: initial.telemetryHistory,
        generatedAt: at,
      });
    // Valid telemetry keeps flowing while the snapshot channel stays dead:
    // the snapshot watchdog must still arm the fallback.
    for (let i = 1; i <= 8; i++) {
      act(() => source.emit("telemetry", telemetryFrame(NOW + i * 3_000)));
      await advance(3_000);
    }
    expect(result.current.transport.pollingState).toBe("active");
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // Even more valid telemetry: fallback keeps polling for snapshots.
    act(() => source.emit("telemetry", telemetryFrame(NOW + 60_000)));
    await advance(7_500);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    expect(result.current.transport.pollingState).toBe("active");
    // Only a valid SNAPSHOT stands the fallback down.
    act(() =>
      source.emit("snapshot", JSON.stringify(makeFakeSnapshot("downloads", NOW + 90_000))),
    );
    expect(result.current.transport.pollingState).toBe("idle");
  });

  it("a valid SSE snapshot aborts the in-flight fallback request", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    let aborted = false;
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const newer = makeFakeSnapshot("downloads", NOW + 2_000);
    await act(async () => {
      source.emit("snapshot", JSON.stringify(newer));
      await flush();
    });
    expect(aborted).toBe(true);
    expect(result.current.snapshot.generatedAt).toBe(NOW + 2_000);
    expect(result.current.transport.pollingState).toBe("idle");
  });

  it("an older fallback response never overwrites a newer SSE snapshot", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    let resolveFetch!: (value: unknown) => void;
    // A slow fallback request that ignores abort and resolves late.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    await act(async () => {
      source.onerror?.();
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const newer = makeFakeSnapshot("downloads", NOW + 10_000);
    act(() => source.emit("snapshot", JSON.stringify(newer)));
    expect(result.current.snapshot.generatedAt).toBe(NOW + 10_000);

    // The stale response finally lands with an OLDER generation: discarded.
    await act(async () => {
      resolveFetch({ ok: true, json: async () => makeFakeSnapshot("idle", NOW + 3_000) });
      await flush();
    });
    expect(result.current.snapshot.generatedAt).toBe(NOW + 10_000);
    expect(result.current.snapshot.acquisition.rollup.downloading).toBeGreaterThan(0);
  });

  it("a replayed older SSE snapshot is ignored", () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());
    act(() =>
      source.emit("snapshot", JSON.stringify(makeFakeSnapshot("downloads", NOW + 10_000))),
    );
    expect(result.current.snapshot.generatedAt).toBe(NOW + 10_000);

    act(() =>
      source.emit("snapshot", JSON.stringify(makeFakeSnapshot("idle", NOW + 5_000))),
    );
    expect(result.current.snapshot.generatedAt).toBe(NOW + 10_000);
    expect(result.current.snapshot.acquisition.rollup.downloading).toBeGreaterThan(0);
  });

  it("an older telemetry frame cannot overwrite telemetry applied by a newer snapshot", () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const { result } = renderHook(() => useLiveData(initial, { frozen: false }));
    const source = FakeEventSource.instances[0]!;
    act(() => source.onopen?.());
    act(() =>
      source.emit("snapshot", JSON.stringify(makeFakeSnapshot("downloads", NOW + 10_000))),
    );
    // A replayed telemetry frame older than the snapshot's generation: rejected.
    act(() =>
      source.emit(
        "telemetry",
        JSON.stringify({
          telemetry: initial.telemetry,
          history: initial.telemetryHistory,
          generatedAt: NOW + 5_000,
        }),
      ),
    );
    expect(result.current.transport.lastTelemetryGeneratedAt).toBeNull();
  });

  it("visibility resume reconnects exactly once and fetches one snapshot", async () => {
    const initial = makeFakeSnapshot("idle", NOW);
    const fetchMock = okFetch(makeFakeSnapshot("idle", NOW + 1));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useLiveData(initial, { frozen: false }));

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
