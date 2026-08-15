import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testPool } from "@/lib/test/factories";
import { migrate } from "@/lib/db/migrate";
import { activeAlerts, resolveAlert, upsertAlert } from "@/lib/db/repository";
import { evaluate, type AlertState } from "@/lib/attention/engine";
import { detectConditions, ruleTimings, type AttentionInputs } from "@/lib/attention/rules";
import { appConfig } from "@/lib/config";
import type { DB } from "@/lib/db/types";

/**
 * End-to-end attention persistence: rules -> engine -> alerts table. Proves the
 * lifecycle (open, dedupe/upsert, resolve) survives in the DB with per-instance
 * identity, exactly as the live registry drives it.
 */

let db: DB;
const timings = ruleTimings(appConfig.thresholds);

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const pool = testPool;

/** Mirror the registry's persist step for alert lifecycle. */
function persist(states: Map<string, AlertState>, resolved: AlertState[], now: number) {
  for (const s of states.values()) {
    if (s.status !== "active") continue;
    upsertAlert(db, {
      alertId: s.alertId, ruleId: s.ruleId, severity: s.severity, title: s.title,
      detail: s.detail, source: s.source, subject: s.subject ?? null,
      firstSeenAt: s.firstSeenAt ?? now, lastSeenAt: s.lastSeenAt,
    });
  }
  for (const s of resolved) resolveAlert(db, s.alertId, s.resolvedAt ?? now);
}

function tick(states: Map<string, AlertState>, inputs: AttentionInputs, now: number) {
  const r = evaluate(states, detectConditions(inputs), timings, now);
  persist(r.states, r.resolved, now);
  return r;
}

describe("attention persistence — full lifecycle", () => {
  it("opens, dedupes across ticks, then resolves in the alerts table", () => {
    const thresholds = appConfig.thresholds;
    let states = new Map<string, AlertState>();
    const T = 1_754_000_000_000;

    // Two pools cross the critical threshold simultaneously.
    const full: AttentionInputs = {
      health: [], acquisition: [], thresholds,
      pools: [pool({ name: "tank", capacityFraction: 0.95 }), pool({ name: "backup", capacityFraction: 0.93 })],
    };
    let r = tick(states, full, T);
    states = r.states;
    expect(activeAlerts(db)).toHaveLength(2); // two independent instances persisted

    // Same condition next tick → upsert, not a duplicate row.
    r = tick(states, full, T + 60_000);
    states = r.states;
    expect(activeAlerts(db)).toHaveLength(2);
    const tank = activeAlerts(db).find((a) => a.subject === "tank")!;
    expect(tank.lastSeenAt).toBe(T + 60_000);
    expect(tank.firstSeenAt).toBe(T); // first_seen preserved

    // One pool recovers below threshold; capacity clearMs is 60s, so it stays
    // active until the clear window elapses, then resolves.
    const oneRecovered: AttentionInputs = {
      health: [], acquisition: [], thresholds,
      pools: [pool({ name: "tank", capacityFraction: 0.95 }), pool({ name: "backup", capacityFraction: 0.5 })],
    };
    r = tick(states, oneRecovered, T + 90_000); // within clear window
    states = r.states;
    expect(activeAlerts(db)).toHaveLength(2); // backup still active (hysteresis)

    r = tick(states, oneRecovered, T + 130_000); // past clear window
    states = r.states;
    const open = activeAlerts(db);
    expect(open).toHaveLength(1);
    expect(open[0]!.subject).toBe("tank");
  });
});
