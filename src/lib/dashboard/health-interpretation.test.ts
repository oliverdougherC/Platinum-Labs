import { describe, expect, it } from "vitest";
import { interpretHealth, healthHeadline } from "@/lib/dashboard/health-interpretation";
import type {
  AttentionItem,
  ConnectorHealth,
  ConnectorId,
  DashboardSnapshot,
  ZfsPool,
} from "@/lib/types";

const NOW = 1_754_000_000_000;

function health(
  id: ConnectorId,
  overrides: Partial<ConnectorHealth> = {},
): ConnectorHealth {
  return {
    id,
    status: "healthy",
    configured: true,
    lastSuccessAt: NOW - 5_000,
    lastError: null,
    configError: null,
    pollIntervalMs: 10_000,
    ...overrides,
  };
}

function pool(overrides: Partial<ZfsPool> = {}): ZfsPool {
  return {
    name: "tank",
    usedBytes: 10,
    totalBytes: 20,
    capacityFraction: 0.5,
    health: "ONLINE",
    scan: "none",
    lastScrubAt: null,
    scrubErrors: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    mode: "live",
    generatedAt: NOW,
    health: [health("jellyfin"), health("zfs")],
    jellyfin: { serverAvailable: true, version: "10.9", sessions: [], lastPlaybackAt: null },
    acquisition: { items: [], rollup: { downloading: 0, importing: 0, failedOrStalled: 0, aggregateRateBps: 0 } },
    zfs: { pools: [pool()] },
    attention: [],
    activity: [],
    ...overrides,
  };
}

describe("interpretHealth", () => {
  it("healthy only when positively established (all fresh, pools ONLINE)", () => {
    const r = interpretHealth(snapshot(), NOW);
    expect(r.kind).toBe("healthy");
    expect(healthHeadline(r)).toBe("Everything looks good.");
  });

  it("REGRESSION: empty attention + an unavailable configured connector is NOT healthy", () => {
    const r = interpretHealth(
      snapshot({
        attention: [],
        health: [health("jellyfin", { status: "unavailable" }), health("zfs")],
      }),
      NOW,
    );
    expect(r.kind).toBe("incomplete");
    if (r.kind === "incomplete") expect(r.reasons.join(" ")).toContain("Jellyfin");
    expect(healthHeadline(r)).not.toBe("Everything looks good.");
  });

  it("stale configured connector is incomplete, not healthy", () => {
    const stale = health("jellyfin", { lastSuccessAt: NOW - 10 * 60_000 }); // > 3× interval
    const r = interpretHealth(snapshot({ health: [stale, health("zfs")] }), NOW);
    expect(r.kind).toBe("incomplete");
  });

  it("misconfigured connector is incomplete", () => {
    const bad = health("sonarr", { configured: false, configError: "missing SONARR_API_KEY" });
    const r = interpretHealth(snapshot({ health: [health("jellyfin"), health("zfs"), bad] }), NOW);
    expect(r.kind).toBe("incomplete");
    if (r.kind === "incomplete") expect(r.reasons.join(" ")).toContain("Sonarr");
  });

  it("configured ZFS with no pool data is incomplete (not healthy empty state)", () => {
    const r = interpretHealth(snapshot({ zfs: { pools: [] } }), NOW);
    expect(r.kind).toBe("incomplete");
    if (r.kind === "incomplete") expect(r.reasons.join(" ")).toContain("Storage");
  });

  it("unconfigured connectors do not block a healthy verdict", () => {
    const r = interpretHealth(
      snapshot({
        health: [
          health("jellyfin"),
          health("zfs"),
          health("sonarr", { configured: false, status: "unavailable", lastSuccessAt: null }),
        ],
      }),
      NOW,
    );
    expect(r.kind).toBe("healthy");
  });

  it("non-ONLINE pool is attention even with an empty alert list", () => {
    const r = interpretHealth(snapshot({ zfs: { pools: [pool({ health: "DEGRADED" })] } }), NOW);
    expect(r.kind).toBe("attention");
    if (r.kind === "attention") expect(r.items[0]!.severity).toBe("critical");
  });

  it("explicit alerts win and are sorted most-severe first", () => {
    const warn: AttentionItem = {
      ruleId: "a", alertId: "a", severity: "warning", title: "w", detail: "warn", source: "zfs", firstSeenAt: NOW, lastSeenAt: NOW,
    };
    const crit: AttentionItem = {
      ruleId: "b", alertId: "b", severity: "critical", title: "c", detail: "crit", source: "zfs", firstSeenAt: NOW, lastSeenAt: NOW,
    };
    const r = interpretHealth(snapshot({ attention: [warn, crit] }), NOW);
    expect(r.kind).toBe("attention");
    if (r.kind === "attention") expect(r.items[0]!.severity).toBe("critical");
  });
});
