/**
 * Deterministic system-attention engine (PLA-189).
 *
 * Pure and isomorphic. Given the previous alert state, the set of conditions
 * currently violating a rule, per-rule timings, and `now`, it produces:
 *
 *   - the next alert state map (to feed back next tick),
 *   - the active `AttentionItem[]` (deduped, most-severe first),
 *   - the alerts that just *opened* and just *resolved* (for activity events).
 *
 * Grace + hysteresis are built in:
 *   - a condition must persist for its rule's `graceMs` before it becomes an
 *     active alert (one missed poll never raises an alert),
 *   - once active, an alert stays active until its condition has been absent for
 *     `clearMs` (flapping prevention),
 *   - identity is the stable `alertId` (rule + subject), so two pools breaching
 *     the same rule are two independent alerts.
 *
 * The engine never throws on a single bad rule: condition *detection* is done by
 * separate, individually try/caught rule functions (see rules.ts); the engine
 * itself only manipulates already-normalized conditions.
 */

import type { AttentionItem, ConnectorId, Severity } from "@/lib/types";

/** A rule currently firing for a specific subject. */
export interface AlertCondition {
  /** Stable instance id, unique across simultaneous entities, e.g. `zfs.capacity.critical:tank`. */
  alertId: string;
  /** Reusable rule class id, e.g. `zfs.capacity.critical`. */
  ruleId: string;
  severity: Severity;
  title: string;
  detail: string;
  source: ConnectorId;
  subject?: string;
}

export interface RuleTiming {
  /** How long a condition must persist before it becomes an active alert. */
  graceMs: number;
  /** How long a condition must be absent before an active alert resolves. */
  clearMs: number;
}

export const DEFAULT_TIMING: RuleTiming = { graceMs: 0, clearMs: 0 };

export type AlertStatus = "pending" | "active" | "resolved";

/** Persistent per-alert state carried across ticks. */
export interface AlertState {
  alertId: string;
  ruleId: string;
  severity: Severity;
  title: string;
  detail: string;
  source: ConnectorId;
  subject?: string;
  status: AlertStatus;
  /** When the current condition streak was first observed (for grace). */
  firstObservedAt: number;
  /** When it became an active alert (AttentionItem.firstSeenAt), or null. */
  firstSeenAt: number | null;
  /** Last time the condition was observed present. */
  lastSeenAt: number;
  /** Set when the alert resolved. */
  resolvedAt: number | null;
}

export interface EvaluateResult {
  states: Map<string, AlertState>;
  active: AttentionItem[];
  opened: AlertState[];
  resolved: AlertState[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function timingFor(
  timings: Record<string, RuleTiming>,
  ruleId: string,
  fallback: RuleTiming,
): RuleTiming {
  return timings[ruleId] ?? fallback;
}

function toItem(s: AlertState): AttentionItem {
  return {
    ruleId: s.ruleId,
    alertId: s.alertId,
    severity: s.severity,
    title: s.title,
    detail: s.detail,
    source: s.source,
    subject: s.subject,
    firstSeenAt: s.firstSeenAt ?? s.firstObservedAt,
    lastSeenAt: s.lastSeenAt,
    resolvedAt: s.resolvedAt,
  };
}

/**
 * Advance the engine by one tick. Deterministic: identical (prev, conditions,
 * timings, now) always yields an identical result, so duplicate evaluation at
 * the same instant is a no-op.
 */
export function evaluate(
  prev: Map<string, AlertState>,
  conditions: AlertCondition[],
  timings: Record<string, RuleTiming> = {},
  now: number,
  fallback: RuleTiming = DEFAULT_TIMING,
): EvaluateResult {
  const next = new Map<string, AlertState>();
  const opened: AlertState[] = [];
  const resolved: AlertState[] = [];
  const conditionById = new Map(conditions.map((c) => [c.alertId, c]));

  // 1. Advance every currently-firing condition.
  for (const c of conditions) {
    const t = timingFor(timings, c.ruleId, fallback);
    const prior = prev.get(c.alertId);

    if (!prior || prior.status === "resolved") {
      // Fresh streak (or re-firing after resolution): start pending, re-graced.
      const state: AlertState = {
        alertId: c.alertId,
        ruleId: c.ruleId,
        severity: c.severity,
        title: c.title,
        detail: c.detail,
        source: c.source,
        subject: c.subject,
        status: "pending",
        firstObservedAt: now,
        firstSeenAt: null,
        lastSeenAt: now,
        resolvedAt: null,
      };
      // Grace of 0 promotes immediately.
      if (now - state.firstObservedAt >= t.graceMs) {
        state.status = "active";
        state.firstSeenAt = now;
        opened.push(state);
      }
      next.set(c.alertId, state);
      continue;
    }

    // Existing streak — refresh presentation, keep timing anchors.
    const state: AlertState = {
      ...prior,
      severity: c.severity,
      title: c.title,
      detail: c.detail,
      lastSeenAt: now,
      resolvedAt: null,
    };
    if (prior.status === "pending") {
      if (now - prior.firstObservedAt >= t.graceMs) {
        state.status = "active";
        state.firstSeenAt = now;
        opened.push(state);
      }
    }
    next.set(c.alertId, state);
  }

  // 2. Advance alerts whose condition is currently absent (hysteresis / resolve).
  for (const [alertId, prior] of prev) {
    if (conditionById.has(alertId)) continue; // handled above
    if (prior.status === "resolved") {
      // Keep the resolved record briefly so consumers can observe it, then drop.
      // (Persistence/retention owns long-term history; we only need one tick.)
      continue;
    }
    if (prior.status === "pending") {
      // Never activated → simply disappears, no alert, no event.
      continue;
    }
    // Active: apply hysteresis before resolving.
    const t = timingFor(timings, prior.ruleId, fallback);
    if (now - prior.lastSeenAt >= t.clearMs) {
      const state: AlertState = { ...prior, status: "resolved", resolvedAt: now };
      resolved.push(state);
      // Not carried into `next` (it has resolved); emitted once as `resolved`.
    } else {
      // Still within the clear window — keep it active (flapping prevention).
      next.set(alertId, prior);
    }
  }

  const active = [...next.values()]
    .filter((s) => s.status === "active")
    .map(toItem)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.alertId.localeCompare(b.alertId));

  return { states: next, active, opened, resolved };
}
