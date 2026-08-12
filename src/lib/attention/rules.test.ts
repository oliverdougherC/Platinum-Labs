import { describe, expect, it } from "vitest";
import { detectConditions, RULE, type AttentionInputs } from "@/lib/attention/rules";
import { appConfig } from "@/lib/config";
import type { AcquisitionItem, ConnectorHealth, ZfsPool } from "@/lib/types";

const thresholds = appConfig.thresholds;

function health(id: ConnectorHealth["id"], overrides: Partial<ConnectorHealth> = {}): ConnectorHealth {
  return {
    id, status: "healthy", configured: true, lastSuccessAt: 1, lastError: null,
    configError: null, pollIntervalMs: 10_000, ...overrides,
  };
}
function pool(overrides: Partial<ZfsPool> = {}): ZfsPool {
  return {
    name: "tank", usedBytes: 10, totalBytes: 100, capacityFraction: 0.1,
    health: "ONLINE", scan: "none", lastScrubAt: null, scrubErrors: 0, ...overrides,
  };
}
function item(overrides: Partial<AcquisitionItem> = {}): AcquisitionItem {
  return {
    id: "q1", source: "qbittorrent", title: "Thing", quality: null,
    state: "downloading", progress: 0.5, rateBps: 1000, etaSeconds: 60, ...overrides,
  };
}
function inputs(overrides: Partial<AttentionInputs> = {}): AttentionInputs {
  return { health: [], pools: [], acquisition: [], thresholds, ...overrides };
}

const ids = (conds: ReturnType<typeof detectConditions>) => conds.map((c) => c.ruleId);

describe("rule: connector unavailable", () => {
  it("fires for a configured, unavailable connector", () => {
    const c = detectConditions(inputs({ health: [health("jellyfin", { status: "unavailable" })] }));
    expect(c.map((x) => x.alertId)).toContain(`${RULE.connectorUnavailable}:jellyfin`);
  });
  it("does not fire for healthy, degraded, unconfigured, or misconfigured", () => {
    const c = detectConditions(inputs({
      health: [
        health("jellyfin", { status: "healthy" }),
        health("sonarr", { status: "degraded" }),
        health("radarr", { configured: false, status: "unavailable" }),
        health("zfs", { configError: "missing url", configured: false, status: "unavailable" }),
      ],
    }));
    expect(ids(c)).not.toContain(RULE.connectorUnavailable);
  });
});

describe("rule: pool health", () => {
  it("fires when a pool is not ONLINE", () => {
    const c = detectConditions(inputs({ pools: [pool({ health: "DEGRADED" })] }));
    expect(ids(c)).toContain(RULE.poolNotOnline);
    expect(c[0]!.severity).toBe("critical");
  });
  it("does not fire for ONLINE pools", () => {
    expect(ids(detectConditions(inputs({ pools: [pool()] })))).not.toContain(RULE.poolNotOnline);
  });
});

describe("rule: capacity thresholds", () => {
  it("warns in the warning band and criticals in the critical band (never both)", () => {
    const warn = detectConditions(inputs({ pools: [pool({ capacityFraction: 0.85 })] }));
    expect(ids(warn)).toEqual([RULE.capacityWarning]);
    const crit = detectConditions(inputs({ pools: [pool({ capacityFraction: 0.95 })] }));
    expect(ids(crit)).toEqual([RULE.capacityCritical]);
  });
  it("stays quiet below the warning threshold", () => {
    expect(detectConditions(inputs({ pools: [pool({ capacityFraction: 0.5 })] }))).toHaveLength(0);
  });
  it("tracks two full pools as two independent conditions", () => {
    const c = detectConditions(inputs({
      pools: [pool({ name: "tank", capacityFraction: 0.95 }), pool({ name: "backup", capacityFraction: 0.92 })],
    }));
    expect(c.map((x) => x.alertId).sort()).toEqual([
      `${RULE.capacityCritical}:backup`,
      `${RULE.capacityCritical}:tank`,
    ]);
  });
});

describe("rule: scrub errors", () => {
  it("fires when the last scrub reported errors", () => {
    const c = detectConditions(inputs({ pools: [pool({ scrubErrors: 3 })] }));
    expect(ids(c)).toContain(RULE.scrubErrors);
    expect(c[0]!.detail).toContain("3 errors");
  });
  it("stays quiet with zero scrub errors", () => {
    expect(detectConditions(inputs({ pools: [pool({ scrubErrors: 0 })] }))).toHaveLength(0);
  });
});

describe("rule: transfers", () => {
  it("fires stalled and failed distinctly", () => {
    const c = detectConditions(inputs({
      acquisition: [item({ id: "a", state: "stalled" }), item({ id: "b", state: "failed" })],
    }));
    expect(c.map((x) => x.alertId).sort()).toEqual([
      `${RULE.transferStalled}:a`,
      `${RULE.transferError}:b`,
    ]);
  });
  it("does not fire for downloading/importing/completed", () => {
    const c = detectConditions(inputs({
      acquisition: [item({ state: "downloading" }), item({ state: "importing" }), item({ state: "completed" })],
    }));
    expect(c).toHaveLength(0);
  });
});

describe("detectConditions — resilience + missing data", () => {
  it("returns nothing for a fully-empty snapshot (no throw)", () => {
    expect(detectConditions(inputs())).toEqual([]);
  });
  it("handles many simultaneous conditions across rules", () => {
    const c = detectConditions(inputs({
      health: [health("jellyfin", { status: "unavailable" })],
      pools: [pool({ name: "tank", health: "DEGRADED", capacityFraction: 0.95, scrubErrors: 2 })],
      acquisition: [item({ id: "x", state: "stalled" })],
    }));
    // connector + not-online + capacity-critical + scrub + stalled = 5
    expect(c).toHaveLength(5);
  });
});
