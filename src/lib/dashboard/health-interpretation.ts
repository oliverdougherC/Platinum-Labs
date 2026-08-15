/**
 * Top-level health interpretation (Phase 1.4).
 *
 * An empty attention list must NEVER by itself be read as "everything is fine".
 * This pure function positively establishes one of three states from real
 * signals in the snapshot:
 *
 *   - `attention`  — one or more alerts, or a directly-observed bad condition
 *                    (non-ONLINE pool) that the attention engine would raise.
 *   - `incomplete` — a configured connector is unavailable/stale/misconfigured,
 *                    or a configured ZFS connector has no pool data: we cannot
 *                    confidently say the system is healthy.
 *   - `healthy`    — positively established: every configured connector is
 *                    healthy and fresh, all pools are ONLINE, and storage data
 *                    is present (or ZFS is intentionally unconfigured).
 *
 * Isomorphic and secret-free so both the server and the client can reason about
 * it identically.
 */

import {
  isConnectorStale,
  type AttentionItem,
  type ConnectorHealth,
  type DashboardSnapshot,
} from "@/lib/types";

export type OverallHealth =
  | { kind: "healthy" }
  | { kind: "attention"; items: AttentionItem[] }
  | { kind: "incomplete"; reasons: string[] };

const SEVERITY_RANK: Record<AttentionItem["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function connectorLabel(id: ConnectorHealth["id"]): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function interpretHealth(
  snapshot: DashboardSnapshot,
  now: number,
): OverallHealth {
  // 1. Explicit alerts always win and are shown most-severe first.
  if (snapshot.attention.length > 0) {
    const items = [...snapshot.attention].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    return { kind: "attention", items };
  }

  // 2. A directly-observed non-ONLINE pool is an attention condition even before
  //    the deterministic engine has (re)materialized an alert row for it.
  const badPool = snapshot.zfs.pools.find((p) => p.health !== "ONLINE");
  if (badPool) {
    return {
      kind: "attention",
      items: [
        {
          ruleId: "zfs.pool.not-online",
          alertId: `zfs.pool.not-online:${badPool.name}`,
          severity: "critical",
          title: "Pool not healthy",
          detail: `Pool ${badPool.name} is ${badPool.health}.`,
          source: "zfs",
          subject: badPool.name,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ],
    };
  }

  // 3. Can we confidently say healthy? Only if no configured connector is in a
  //    non-healthy or unevaluable state, and ZFS (if configured) has data.
  const reasons: string[] = [];
  for (const h of snapshot.health) {
    if (h.configError) {
      reasons.push(`${connectorLabel(h.id)} is misconfigured`);
      continue;
    }
    if (!h.configured) continue; // intentionally absent — not a health concern
    if (h.status === "unavailable") {
      reasons.push(`${connectorLabel(h.id)} is unavailable`);
    } else if (h.status !== "healthy" || isConnectorStale(h, now)) {
      reasons.push(`${connectorLabel(h.id)} data is stale`);
    }
  }

  const zfs = snapshot.health.find((h) => h.id === "zfs");
  if (zfs && zfs.configured && !zfs.configError && snapshot.zfs.pools.length === 0) {
    reasons.push("Storage data is unavailable");
  }

  if (reasons.length > 0) return { kind: "incomplete", reasons };

  return { kind: "healthy" };
}

/**
 * The single terse headline for the attention surface. Truthful by construction:
 * the reassuring sentence only appears for a positively-established healthy state.
 */
export function healthHeadline(overall: OverallHealth): string {
  switch (overall.kind) {
    case "healthy":
      return "Everything looks good.";
    case "incomplete":
      return "Status incomplete — some data is unavailable.";
    case "attention":
      return overall.items[0]!.detail;
  }
}
