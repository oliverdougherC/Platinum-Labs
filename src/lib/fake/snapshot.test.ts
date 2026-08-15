import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCENARIO,
  isScenario,
  makeFakeSnapshot,
  SCENARIOS,
  SCENARIO_LABELS,
} from "@/lib/fake/snapshot";
import { isConnectorStale } from "@/lib/types";

const NOW = 1_754_000_000_000; // fixed epoch for deterministic assertions

describe("scenario registry", () => {
  it("has a label for every scenario", () => {
    for (const s of SCENARIOS) {
      expect(SCENARIO_LABELS[s]).toBeTruthy();
    }
  });

  it("isScenario guards untrusted input", () => {
    expect(isScenario("idle")).toBe(true);
    expect(isScenario("../etc/passwd")).toBe(false);
    expect(isScenario(undefined)).toBe(false);
    expect(isScenario(42)).toBe(false);
  });
});

describe("every scenario is deterministic and well-formed", () => {
  for (const s of SCENARIOS) {
    it(`${s}: identical output for a fixed now, valid shape`, () => {
      const a = makeFakeSnapshot(s, NOW);
      const b = makeFakeSnapshot(s, NOW);
      expect(a).toEqual(b);

      expect(a.mode).toBe("fake");
      expect(a.generatedAt).toBe(NOW);
      // Health is reported for all six connectors in every scenario.
      expect(a.health.map((h) => h.id).sort()).toEqual(
        ["jellyfin", "qbittorrent", "radarr", "sonarr", "zfs", "host"].sort(),
      );
      // Pool capacity fractions are always derived consistently.
      for (const pool of a.zfs.pools) {
        expect(pool.capacityFraction).toBeCloseTo(
          pool.usedBytes / pool.totalBytes,
          6,
        );
      }
    });
  }
});

describe("required scenario characteristics", () => {
  it("idle: nothing active, nothing needs attention", () => {
    const s = makeFakeSnapshot("idle", NOW);
    expect(s.jellyfin.sessions).toHaveLength(0);
    expect(s.acquisition.items).toHaveLength(0);
    expect(s.attention).toHaveLength(0);
  });

  it("transcode: a session is actually transcoding", () => {
    const s = makeFakeSnapshot("transcode", NOW);
    expect(s.jellyfin.sessions.some((x) => x.method === "transcode")).toBe(true);
  });

  it("multi-session: more than one concurrent session", () => {
    expect(
      makeFakeSnapshot("multi-session", NOW).jellyfin.sessions.length,
    ).toBeGreaterThan(1);
  });

  it("downloads: something is downloading or importing", () => {
    const r = makeFakeSnapshot("downloads", NOW).acquisition.rollup;
    expect(r.downloading + r.importing).toBeGreaterThan(0);
    expect(r.aggregateRateBps).toBeGreaterThan(0);
  });

  it("stalled: a stalled/failed transfer is present", () => {
    expect(
      makeFakeSnapshot("stalled", NOW).acquisition.rollup.failedOrStalled,
    ).toBeGreaterThan(0);
  });

  it("connector-unavailable: a connector is unavailable but configured", () => {
    const jf = makeFakeSnapshot("connector-unavailable", NOW).health.find(
      (h) => h.id === "jellyfin",
    )!;
    expect(jf.status).toBe("unavailable");
    expect(jf.configured).toBe(true);
  });

  it("stale: last-known-good data present while a connector is degraded and stale", () => {
    const s = makeFakeSnapshot("stale", NOW);
    const qb = s.health.find((h) => h.id === "qbittorrent")!;
    expect(qb.status).toBe("degraded");
    expect(isConnectorStale(qb, NOW)).toBe(true);
    // last-known-good acquisition data is still shown
    expect(s.acquisition.items.length).toBeGreaterThan(0);
  });

  it("zfs-warning: a pool is near the warning threshold", () => {
    const datastore = makeFakeSnapshot("zfs-warning", NOW).zfs.pools.find(
      (p) => p.name === "DataStore",
    )!;
    expect(datastore.capacityFraction).toBeGreaterThan(0.8);
    // Headline capacity is LOGICAL (root dataset), never raw physical (PLA-264).
    expect(datastore.capacityBasis).toBe("logical");
    expect(datastore.logical).not.toBeNull();
    expect(datastore.physical.sizeBytes).toBeGreaterThan(datastore.logical!.totalBytes);
    expect(datastore.health).toBe("ONLINE");
  });

  it("zfs-degraded: a pool is DEGRADED with scrub errors", () => {
    const s = makeFakeSnapshot("zfs-degraded", NOW);
    const bad = s.zfs.pools.find((p) => p.health !== "ONLINE")!;
    expect(bad.health).toBe("DEGRADED");
    expect(bad.scrubErrors).toBeGreaterThan(0);
  });

  it("unconfigured: no connectors configured and no pools", () => {
    const s = makeFakeSnapshot("unconfigured", NOW);
    expect(s.health.every((h) => h.configured === false)).toBe(true);
    expect(s.zfs.pools).toHaveLength(0);
    expect(s.jellyfin.serverAvailable).toBe(false);
  });

  it("default scenario resolves to a real builder", () => {
    expect(isScenario(DEFAULT_SCENARIO)).toBe(true);
    expect(makeFakeSnapshot()).toBeTruthy();
  });
});

describe("fake mode performs no network I/O", () => {
  afterEach(() => vi.restoreAllMocks());

  it("building any scenario never calls fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const s of SCENARIOS) makeFakeSnapshot(s, NOW);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
