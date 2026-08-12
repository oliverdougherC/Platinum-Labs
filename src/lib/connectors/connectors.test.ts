import { describe, expect, it } from "vitest";
import { ConnectorRuntime } from "@/lib/connectors/runtime";
import { ConnectorHub } from "@/lib/connectors/hub";
import { ConnectorError, type Connector } from "@/lib/connectors/connector";
import {
  countingSlowConnector,
  failingConnector,
  flakyConnector,
  hangingConnector,
  healthyConnector,
  leakyConnector,
  validatingConnector,
  type Ping,
} from "@/lib/connectors/fixtures";

/** A clock we can advance for deterministic staleness tests. */
function fakeClock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms: number) => (state.t += ms) };
}

describe("ConnectorRuntime — success", () => {
  it("becomes healthy with a snapshot and lastSuccessAt", async () => {
    const clock = fakeClock();
    const rt = new ConnectorRuntime(healthyConnector("jellyfin", 7), {
      now: clock.now,
    });
    const state = await rt.refresh();
    expect(state.snapshot).toEqual({ ok: true, value: 7 });
    expect(state.health.status).toBe("healthy");
    expect(state.health.lastSuccessAt).toBe(clock.now());
    expect(state.health.lastError).toBeNull();
    expect(state.health.configured).toBe(true);
  });
});

describe("ConnectorRuntime — failure & sanitization", () => {
  it("no last-known-good → unavailable with a client-safe error", async () => {
    const rt = new ConnectorRuntime(failingConnector("sonarr"));
    const { snapshot, health } = await rt.refresh();
    expect(snapshot).toBeNull();
    expect(health.status).toBe("unavailable");
    expect(health.lastError).toBe("service returned HTTP 503");
  });

  it("never leaks secrets from an unknown error", async () => {
    const rt = new ConnectorRuntime(leakyConnector("radarr"));
    const { health } = await rt.refresh();
    expect(health.lastError).toBe("Upstream request failed");
    expect(health.lastError).not.toContain("SUPERSECRET");
  });

  it("malformed upstream data is a clean validation error", async () => {
    const rt = new ConnectorRuntime(
      validatingConnector({ ok: true, value: "not-a-number" }, "zfs"),
    );
    const { snapshot, health } = await rt.refresh();
    expect(snapshot).toBeNull();
    expect(health.status).toBe("unavailable");
    expect(health.lastError).toMatch(/Malformed upstream response/);
  });
});

describe("ConnectorRuntime — timeout", () => {
  it("times out a hanging poll and reports it", async () => {
    const rt = new ConnectorRuntime(hangingConnector("qbittorrent"), {
      timeoutMs: 15,
    });
    const { health } = await rt.refresh();
    expect(health.status).toBe("unavailable");
    expect(health.lastError).toMatch(/Timed out after 15ms/);
  });
});

describe("ConnectorRuntime — last-known-good, degraded, recovery, staleness", () => {
  it("retains LKG on failure and transitions degraded → unavailable by grace", async () => {
    const clock = fakeClock();
    let mode: "ok" | "fail" = "ok";
    const connector: Connector<Ping> = {
      id: "jellyfin",
      pollIntervalMs: 10_000,
      async poll() {
        if (mode === "fail") throw new ConnectorError("down");
        return { ok: true, value: 1 };
      },
    };
    const rt = new ConnectorRuntime(connector, { now: clock.now, graceMs: 60_000 });

    await rt.refresh(); // success → healthy, snapshot cached
    expect(rt.getState().health.status).toBe("healthy");

    mode = "fail";
    await rt.refresh(); // fail, within grace → degraded, LKG retained
    let state = rt.getState();
    expect(state.snapshot).toEqual({ ok: true, value: 1 });
    expect(state.health.status).toBe("degraded");

    clock.advance(120_000); // beyond grace
    await rt.refresh();
    state = rt.getState();
    expect(state.health.status).toBe("unavailable");
    expect(state.snapshot).toEqual({ ok: true, value: 1 }); // still serving LKG
  });

  it("recovers to healthy after transient failures", async () => {
    const rt = new ConnectorRuntime(flakyConnector(1, "jellyfin"));
    let state = await rt.refresh(); // fail #1
    expect(state.health.status).toBe("unavailable");
    state = await rt.refresh(); // success
    expect(state.health.status).toBe("healthy");
    expect(state.snapshot?.ok).toBe(true);
  });
});

describe("ConnectorRuntime — overlap protection", () => {
  it("does not run two overlapping polls for the same connector", async () => {
    const { connector, entries, release } = countingSlowConnector("jellyfin");
    const rt = new ConnectorRuntime(connector);

    const p1 = rt.refresh();
    const p2 = rt.refresh(); // should dedupe onto the in-flight poll
    expect(entries()).toBe(1);
    expect(p1).toStrictEqual(p2);

    release();
    await Promise.all([p1, p2]);
    expect(entries()).toBe(1);
  });
});

describe("ConnectorHub — fan-out isolation", () => {
  it("returns partial healthy data when some connectors fail", async () => {
    const hub = new ConnectorHub();
    hub.register(new ConnectorRuntime(healthyConnector("jellyfin", 42)));
    hub.register(new ConnectorRuntime(failingConnector("sonarr")));
    hub.register(new ConnectorRuntime(leakyConnector("radarr")));

    // Must not reject even though two connectors fail.
    await expect(hub.refreshAll()).resolves.toBeUndefined();

    const health = hub.health();
    expect(health).toHaveLength(3);

    const jelly = health.find((h) => h.id === "jellyfin")!;
    expect(jelly.status).toBe("healthy");
    expect(hub.snapshotOf<Ping>("jellyfin")).toEqual({ ok: true, value: 42 });

    expect(health.find((h) => h.id === "sonarr")!.status).toBe("unavailable");
    expect(hub.snapshotOf("sonarr")).toBeNull();

    // Secret isolation across the aggregate.
    for (const h of health) {
      expect(h.lastError ?? "").not.toContain("SUPERSECRET");
    }
  });
});
