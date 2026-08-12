/**
 * Attention rule detectors (PLA-189).
 *
 * Each rule is a pure function from the normalized snapshot to zero-or-more
 * `AlertCondition`s. Rules are evaluated independently and each is wrapped in a
 * try/catch by `detectConditions`, so one rule receiving missing/oddly-shaped
 * data can never throw the whole dashboard — it just contributes no conditions.
 *
 * Timing (grace + hysteresis) is NOT decided here; rules only describe what is
 * *currently* wrong. The engine applies each rule's `RuleTiming`.
 */

import type { RuleTiming } from "@/lib/attention/engine";
import type { AlertCondition } from "@/lib/attention/engine";
import type { ThresholdConfig } from "@/lib/config";
import type { AcquisitionItem, ConnectorHealth, ZfsPool } from "@/lib/types";

export interface AttentionInputs {
  health: ConnectorHealth[];
  pools: ZfsPool[];
  acquisition: AcquisitionItem[];
  thresholds: ThresholdConfig;
}

// --- rule ids ---------------------------------------------------------------

export const RULE = {
  connectorUnavailable: "connector.unavailable",
  poolNotOnline: "zfs.pool.not-online",
  capacityWarning: "zfs.capacity.warning",
  capacityCritical: "zfs.capacity.critical",
  scrubErrors: "zfs.scrub.errors",
  transferStalled: "qbittorrent.transfer.stalled",
  transferError: "transfer.error",
} as const;

/**
 * Per-rule timings derived from configured thresholds.
 *  - connector: the engine owns the entire connector grace (`connectorGraceMs`).
 *    The rule fires a condition as soon as a connector stops being healthy
 *    (degraded serving stale LKG, or unavailable), and the engine only promotes
 *    it to an active alert once that condition has persisted for
 *    `connectorGraceMs`. This makes "connector unavailable beyond the grace
 *    period" literally true for BOTH a connector serving last-known-good and one
 *    that has never had a successful poll (no LKG → runtime reports
 *    `unavailable` immediately, but the alert still waits out the grace).
 *    See PLA-189: a single initial failed poll must never raise an alert.
 *  - stalled transfer: the *configurable stall duration* IS the engine grace.
 */
export function ruleTimings(t: ThresholdConfig): Record<string, RuleTiming> {
  const clearShort = 30_000;
  const clearMed = 60_000;
  return {
    [RULE.connectorUnavailable]: { graceMs: t.connectorGraceMs, clearMs: clearShort },
    [RULE.poolNotOnline]: { graceMs: 0, clearMs: clearShort },
    [RULE.capacityWarning]: { graceMs: 0, clearMs: clearMed },
    [RULE.capacityCritical]: { graceMs: 0, clearMs: clearMed },
    [RULE.scrubErrors]: { graceMs: 0, clearMs: 0 },
    [RULE.transferStalled]: { graceMs: t.stalledTransferSeconds * 1_000, clearMs: clearMed },
    [RULE.transferError]: { graceMs: 0, clearMs: clearMed },
  };
}

// --- individual rules -------------------------------------------------------

function connectorRule(inputs: AttentionInputs): AlertCondition[] {
  const out: AlertCondition[] = [];
  for (const h of inputs.health) {
    // Only configured, fully-set-up connectors. Fire the condition whenever a
    // connector stops being healthy — degraded (serving stale last-known-good)
    // OR unavailable. The engine's `connectorGraceMs` grace then decides whether
    // this becomes an active alert, so one transient failed poll (which flips a
    // connector to degraded/unavailable for a single cycle) never alerts, and a
    // connector that has NEVER succeeded — which the runtime reports as
    // `unavailable` immediately, with no LKG to keep it `degraded` — still has to
    // stay down for the full grace before it alerts (PLA-189).
    if (!h.configured || h.configError) continue;
    if (h.status === "healthy") continue;
    const name = h.id.charAt(0).toUpperCase() + h.id.slice(1);
    out.push({
      alertId: `${RULE.connectorUnavailable}:${h.id}`,
      ruleId: RULE.connectorUnavailable,
      severity: "warning",
      title: `${name} unreachable`,
      detail: `${name} is unreachable.`,
      source: h.id,
      subject: h.id,
    });
  }
  return out;
}

function poolHealthRule(inputs: AttentionInputs): AlertCondition[] {
  const out: AlertCondition[] = [];
  for (const p of inputs.pools) {
    if (p.health === "ONLINE") continue;
    out.push({
      alertId: `${RULE.poolNotOnline}:${p.name}`,
      ruleId: RULE.poolNotOnline,
      severity: "critical",
      title: "Pool not healthy",
      detail: `Pool ${p.name} is ${p.health}.`,
      source: "zfs",
      subject: p.name,
    });
  }
  return out;
}

function capacityRule(inputs: AttentionInputs): AlertCondition[] {
  const { storageWarnFraction, storageCriticalFraction } = inputs.thresholds;
  const out: AlertCondition[] = [];
  for (const p of inputs.pools) {
    const pct = Math.round(p.capacityFraction * 100);
    if (p.capacityFraction >= storageCriticalFraction) {
      out.push({
        alertId: `${RULE.capacityCritical}:${p.name}`,
        ruleId: RULE.capacityCritical,
        severity: "critical",
        title: "Pool almost full",
        detail: `Pool ${p.name} is ${pct}% full.`,
        source: "zfs",
        subject: p.name,
      });
    } else if (p.capacityFraction >= storageWarnFraction) {
      out.push({
        alertId: `${RULE.capacityWarning}:${p.name}`,
        ruleId: RULE.capacityWarning,
        severity: "warning",
        title: "Pool filling",
        detail: `Pool ${p.name} is ${pct}% full.`,
        source: "zfs",
        subject: p.name,
      });
    }
  }
  return out;
}

function scrubRule(inputs: AttentionInputs): AlertCondition[] {
  const out: AlertCondition[] = [];
  for (const p of inputs.pools) {
    if (p.scrubErrors > 0) {
      out.push({
        alertId: `${RULE.scrubErrors}:${p.name}`,
        ruleId: RULE.scrubErrors,
        severity: "warning",
        title: "Scrub found errors",
        detail: `Pool ${p.name}'s last scrub reported ${p.scrubErrors} error${p.scrubErrors === 1 ? "" : "s"}.`,
        source: "zfs",
        subject: p.name,
      });
    }
  }
  return out;
}

function transferRule(inputs: AttentionInputs): AlertCondition[] {
  const out: AlertCondition[] = [];
  for (const item of inputs.acquisition) {
    if (item.state === "stalled") {
      out.push({
        alertId: `${RULE.transferStalled}:${item.id}`,
        ruleId: RULE.transferStalled,
        severity: "warning",
        title: "Transfer stalled",
        detail: `${item.title} has stalled.`,
        source: item.source,
        subject: item.id,
      });
    } else if (item.state === "failed") {
      out.push({
        alertId: `${RULE.transferError}:${item.id}`,
        ruleId: RULE.transferError,
        severity: "warning",
        title: "Transfer failed",
        detail: `${item.title} failed.`,
        source: item.source,
        subject: item.id,
      });
    }
  }
  return out;
}

const RULES: Array<(i: AttentionInputs) => AlertCondition[]> = [
  connectorRule,
  poolHealthRule,
  capacityRule,
  scrubRule,
  transferRule,
];

/**
 * Run every rule, isolating failures. A rule that throws contributes nothing and
 * logs once, rather than breaking attention evaluation for the whole dashboard.
 */
export function detectConditions(inputs: AttentionInputs): AlertCondition[] {
  const out: AlertCondition[] = [];
  for (const rule of RULES) {
    try {
      out.push(...rule(inputs));
    } catch (err) {
      console.error(
        "[attention] rule failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}
