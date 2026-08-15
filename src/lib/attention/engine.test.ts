import { describe, expect, it } from "vitest";
import {
  evaluate,
  type AlertCondition,
  type AlertState,
  type RuleTiming,
} from "@/lib/attention/engine";

const T0 = 1_754_000_000_000;

function cond(overrides: Partial<AlertCondition> = {}): AlertCondition {
  return {
    alertId: "rule.x:tank",
    ruleId: "rule.x",
    severity: "warning",
    title: "T",
    detail: "detail",
    source: "zfs",
    subject: "tank",
    ...overrides,
  };
}

const grace = (graceMs: number, clearMs = 0): Record<string, RuleTiming> => ({
  "rule.x": { graceMs, clearMs },
});

describe("attention engine — grace (activation delay)", () => {
  it("does not trigger before the grace period elapses", () => {
    let states = new Map<string, AlertState>();
    const timings = grace(60_000);

    let r = evaluate(states, [cond()], timings, T0);
    expect(r.active).toHaveLength(0); // pending, within grace
    expect(r.opened).toHaveLength(0);
    states = r.states;

    r = evaluate(states, [cond()], timings, T0 + 30_000);
    expect(r.active).toHaveLength(0); // still within grace
    states = r.states;

    r = evaluate(states, [cond()], timings, T0 + 60_000);
    expect(r.active).toHaveLength(1); // grace elapsed → active
    expect(r.opened).toHaveLength(1);
  });

  it("triggers immediately with zero grace", () => {
    const r = evaluate(new Map(), [cond()], grace(0), T0);
    expect(r.active).toHaveLength(1);
    expect(r.opened).toHaveLength(1);
    expect(r.active[0]!.firstSeenAt).toBe(T0);
  });

  it("a condition that clears during grace never fires an alert", () => {
    let r = evaluate(new Map(), [cond()], grace(60_000), T0);
    // condition gone before grace elapsed
    r = evaluate(r.states, [], grace(60_000), T0 + 10_000);
    expect(r.active).toHaveLength(0);
    expect(r.opened).toHaveLength(0);
    expect(r.resolved).toHaveLength(0); // never activated → no resolve event
  });
});

describe("attention engine — hysteresis (flapping prevention) + recovery", () => {
  it("keeps an active alert during the clear window, then resolves", () => {
    const timings = grace(0, 60_000);
    let r = evaluate(new Map(), [cond()], timings, T0);
    expect(r.active).toHaveLength(1);

    // Condition disappears; within clearMs it stays active.
    r = evaluate(r.states, [], timings, T0 + 30_000);
    expect(r.active).toHaveLength(1);
    expect(r.resolved).toHaveLength(0);

    // Past clearMs → resolves and emits a resolved event exactly once.
    r = evaluate(r.states, [], timings, T0 + 60_000);
    expect(r.active).toHaveLength(0);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.resolvedAt).toBe(T0 + 60_000);
  });

  it("a brief flap within the clear window does not re-open or resolve", () => {
    const timings = grace(0, 60_000);
    let r = evaluate(new Map(), [cond()], timings, T0);
    const firstSeen = r.active[0]!.firstSeenAt;

    r = evaluate(r.states, [], timings, T0 + 10_000); // gone briefly
    r = evaluate(r.states, [cond()], timings, T0 + 20_000); // back
    expect(r.active).toHaveLength(1);
    expect(r.opened).toHaveLength(0); // not a new open — same alert
    expect(r.active[0]!.firstSeenAt).toBe(firstSeen); // identity preserved
  });
});

describe("attention engine — determinism + dedup + multiple entities", () => {
  it("duplicate evaluation at the same instant is a no-op", () => {
    const timings = grace(0);
    const r1 = evaluate(new Map(), [cond()], timings, T0);
    const r2 = evaluate(r1.states, [cond()], timings, T0);
    expect(r2.opened).toHaveLength(0);
    expect(r2.active).toHaveLength(1);
    expect(r2.active[0]!.firstSeenAt).toBe(r1.active[0]!.firstSeenAt);
  });

  it("tracks two entities violating the same rule as independent alerts", () => {
    const timings = grace(0);
    const conds = [
      cond({ alertId: "rule.x:tank", subject: "tank" }),
      cond({ alertId: "rule.x:backup", subject: "backup" }),
    ];
    const r = evaluate(new Map(), conds, timings, T0);
    expect(r.active).toHaveLength(2);
    // Resolving one leaves the other active.
    const r2 = evaluate(r.states, [conds[0]!], grace(0, 0), T0 + 1_000);
    expect(r2.active).toHaveLength(1);
    expect(r2.resolved).toHaveLength(1);
    expect(r2.resolved[0]!.subject).toBe("backup");
  });

  it("sorts active alerts most-severe first", () => {
    const r = evaluate(
      new Map(),
      [
        cond({ alertId: "a", ruleId: "a", severity: "warning" }),
        cond({ alertId: "b", ruleId: "b", severity: "critical" }),
      ],
      { a: { graceMs: 0, clearMs: 0 }, b: { graceMs: 0, clearMs: 0 } },
      T0,
    );
    expect(r.active[0]!.severity).toBe("critical");
  });

  it("refreshes detail/severity on an active alert without re-opening", () => {
    const timings = grace(0);
    let r = evaluate(new Map(), [cond({ detail: "old" })], timings, T0);
    r = evaluate(r.states, [cond({ detail: "new", severity: "critical" })], timings, T0 + 5_000);
    expect(r.opened).toHaveLength(0);
    expect(r.active[0]!.detail).toBe("new");
    expect(r.active[0]!.severity).toBe("critical");
  });
});
