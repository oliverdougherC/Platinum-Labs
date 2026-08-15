/**
 * Regression tests for the connector-unavailable alert grace (PLA-189).
 *
 * The bug: `connector.unavailable` used engine `graceMs = 0` on the assumption
 * that `ConnectorRuntime` had already waited `connectorGraceMs` before a
 * connector reads "unavailable". That is false for a connector that has NEVER
 * had a successful poll — the runtime has no last-known-good, so it reports
 * `unavailable` on the very first failed poll, and a zero-grace rule would open
 * an alert immediately. The fix: the engine owns the full connector grace, and
 * the rule fires a (pending) condition whenever a connector is not healthy.
 *
 * These tests drive the real rule + engine + timings together over ticks.
 */

import { describe, expect, it } from "vitest";
import { detectConditions, ruleTimings, RULE } from "@/lib/attention/rules";
import { evaluate, type AlertState } from "@/lib/attention/engine";
import { appConfig } from "@/lib/config";
import type { ConnectorHealth } from "@/lib/types";

const T0 = 1_754_000_000_000;
const GRACE = appConfig.thresholds.connectorGraceMs; // 90s
const timings = ruleTimings(appConfig.thresholds);

/** A connector health record in a chosen state. */
function health(overrides: Partial<ConnectorHealth> = {}): ConnectorHealth {
  return {
    id: "jellyfin",
    status: "healthy",
    configured: true,
    lastSuccessAt: T0,
    lastError: null,
    configError: null,
    pollIntervalMs: 12_000,
    ...overrides,
  };
}

/** Never-succeeded, currently-failing connector (runtime → unavailable, no LKG). */
const neverSucceeded = (): ConnectorHealth =>
  health({ status: "unavailable", lastSuccessAt: null, lastError: "ECONNREFUSED" });

/** Had LKG, now within the runtime grace (still serving stale data). */
const degradedLkg = (lastSuccessAt: number): ConnectorHealth =>
  health({ status: "degraded", lastSuccessAt, lastError: "timeout" });

/** Had LKG, now past the runtime grace (truly unavailable). */
const unavailableLkg = (lastSuccessAt: number): ConnectorHealth =>
  health({ status: "unavailable", lastSuccessAt, lastError: "timeout" });

function tick(
  states: Map<string, AlertState>,
  h: ConnectorHealth | null,
  now: number,
) {
  const conditions = detectConditions({
    health: h ? [h] : [],
    pools: [],
    acquisition: [],
    thresholds: appConfig.thresholds,
  });
  return evaluate(states, conditions, timings, now);
}

describe("connector grace (PLA-189)", () => {
  it("an initial failed poll (never succeeded) does NOT immediately alert", () => {
    const r = tick(new Map(), neverSucceeded(), T0);
    expect(r.active).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
  });

  it("an initial failure that persists past the grace opens exactly one alert", () => {
    let r = tick(new Map(), neverSucceeded(), T0);
    r = tick(r.states, neverSucceeded(), T0 + GRACE / 2);
    expect(r.active).toHaveLength(0); // still within grace

    r = tick(r.states, neverSucceeded(), T0 + GRACE);
    expect(r.active).toHaveLength(1);
    expect(r.opened).toHaveLength(1);
    expect(r.active[0]!.alertId).toBe(`${RULE.connectorUnavailable}:jellyfin`);
  });

  it("an initial failure followed by a success never alerts", () => {
    let r = tick(new Map(), neverSucceeded(), T0);
    // Recovers on the next poll, well within the grace window.
    r = tick(r.states, health({ status: "healthy", lastSuccessAt: T0 + 12_000 }), T0 + 12_000);
    expect(r.active).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
    expect(r.resolved).toHaveLength(0); // never activated → no resolve event either
    // And it stays quiet long after the grace would have elapsed.
    r = tick(r.states, health({ status: "healthy", lastSuccessAt: T0 + GRACE * 2 }), T0 + GRACE * 2);
    expect(r.active).toHaveLength(0);
  });

  it("existing LKG → degraded → unavailable alerts once, after a single grace (no doubling)", () => {
    // Healthy baseline.
    let r = tick(new Map(), health(), T0);
    expect(r.active).toHaveLength(0);

    // Fails: runtime serves stale LKG (degraded). The condition starts here.
    r = tick(r.states, degradedLkg(T0), T0 + 12_000);
    expect(r.active).toHaveLength(0); // pending, within grace

    // Past the runtime grace it becomes unavailable — but the alert fires on the
    // engine's single grace measured from the first non-healthy tick, not a
    // second stacked grace.
    r = tick(r.states, unavailableLkg(T0), T0 + 12_000 + GRACE);
    expect(r.active).toHaveLength(1);
    expect(r.opened).toHaveLength(1);
  });

  it("recovery clears an active alert with hysteresis (clear window)", () => {
    // Drive it to active first.
    let r = tick(new Map(), neverSucceeded(), T0);
    r = tick(r.states, neverSucceeded(), T0 + GRACE);
    expect(r.active).toHaveLength(1);

    // Connector recovers: condition disappears, alert stays active during the
    // clear window, then resolves once.
    r = tick(r.states, health({ status: "healthy", lastSuccessAt: T0 + GRACE + 1_000 }), T0 + GRACE + 1_000);
    expect(r.active).toHaveLength(1); // hysteresis: still active
    expect(r.resolved).toHaveLength(0);

    r = tick(r.states, health({ status: "healthy", lastSuccessAt: T0 + GRACE + 60_000 }), T0 + GRACE + 60_000);
    expect(r.active).toHaveLength(0);
    expect(r.resolved).toHaveLength(1);
  });

  it("a single transient blip (one degraded tick, then healthy) never alerts", () => {
    let r = tick(new Map(), health(), T0); // healthy
    r = tick(r.states, degradedLkg(T0), T0 + 12_000); // one bad poll
    r = tick(r.states, health({ status: "healthy", lastSuccessAt: T0 + 24_000 }), T0 + 24_000); // recovered
    expect(r.active).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
  });
});
