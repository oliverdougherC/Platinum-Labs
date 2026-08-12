/**
 * ZFS storage connector — pure parsing + normalization (PLA-184).
 *
 * The dashboard never runs browser-controlled shell. The `server-only`
 * collector (zfs.server.ts) executes a FIXED argv (`zpool list -Hp -o …` and
 * `zpool status`) with no interpolation, or fetches a minimal host-side helper
 * API. Both converge on the pure functions here, which are locale-stable
 * (`-p` = exact bytes, `-H` = no header) and fully fixture-tested.
 */

import { z } from "zod";
import { parseUpstream } from "@/lib/connectors/validate";
import type { Connector } from "@/lib/connectors/connector";
import { clamp } from "@/lib/utils";
import type { PoolHealth, ZfsPool, ZfsSnapshot } from "@/lib/types";

const KNOWN_HEALTH: PoolHealth[] = [
  "ONLINE",
  "DEGRADED",
  "FAULTED",
  "OFFLINE",
  "UNAVAIL",
];

export function mapPoolHealth(raw: string | undefined): PoolHealth {
  const up = (raw ?? "").toUpperCase();
  return (KNOWN_HEALTH as string[]).includes(up) ? (up as PoolHealth) : "UNAVAIL";
}

export interface RawPool {
  name: string;
  size: number;
  alloc: number;
  free: number;
  health: string;
}

/**
 * Parse `zpool list -Hp -o name,size,alloc,free,health` output. Tab-separated,
 * exact bytes, no header. Skips any line that doesn't have the expected numeric
 * columns (resilient to unexpected/partial output).
 */
export function parseZpoolList(stdout: string): RawPool[] {
  const pools: RawPool[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    const [name, size, alloc, free, health] = cols;
    const sizeN = Number(size);
    const allocN = Number(alloc);
    const freeN = Number(free);
    if (!name || Number.isNaN(sizeN) || Number.isNaN(allocN)) continue;
    pools.push({
      name,
      size: sizeN,
      alloc: allocN,
      free: Number.isNaN(freeN) ? sizeN - allocN : freeN,
      health: (health ?? "").trim(),
    });
  }
  return pools;
}

export type ScrubState =
  | "none"
  | "in-progress"
  | "resilvering"
  | "completed";

export interface ScrubInfo {
  state: ScrubState;
  errors: number;
  lastScrubAt: number | null;
}

/** Parse `zpool status` for per-pool scrub state, error count, and completion time. */
export function parseZpoolStatus(stdout: string): Record<string, ScrubInfo> {
  const out: Record<string, ScrubInfo> = {};
  let current: string | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("pool:")) {
      current = line.slice("pool:".length).trim();
      out[current] = { state: "none", errors: 0, lastScrubAt: null };
    } else if (current && line.startsWith("scan:")) {
      const scan = line.slice("scan:".length).trim();
      const info = out[current]!;
      if (/resilver in progress/i.test(scan)) info.state = "resilvering";
      else if (/in progress/i.test(scan)) info.state = "in-progress";
      else if (/none requested/i.test(scan)) info.state = "none";
      else if (/repaired|scrub|canceled/i.test(scan)) info.state = "completed";

      const withErrors = scan.match(/with (\d+) errors/i);
      if (withErrors) info.errors = Number(withErrors[1]);

      const on = scan.match(/ on (.+)$/);
      if (on) {
        // Collapse zpool's column-aligned double spaces so Date.parse accepts
        // the ctime-style date (locale-stable enough for our purposes).
        const ts = Date.parse(on[1]!.trim().replace(/\s+/g, " "));
        if (!Number.isNaN(ts)) info.lastScrubAt = ts;
      }
    } else if (current && line.startsWith("errors:")) {
      const errText = line.slice("errors:".length).trim();
      const info = out[current]!;
      const n = errText.match(/(\d+) data errors/i);
      if (n) info.errors = Number(n[1]);
      else if (/no known data errors/i.test(errText) && info.state !== "completed") {
        info.errors = 0;
      }
    }
  }
  return out;
}

/** Combine capacity + scrub info into the normalized snapshot. */
export function buildZfsSnapshot(
  pools: RawPool[],
  scrub: Record<string, ScrubInfo> = {},
): ZfsSnapshot {
  return {
    pools: pools.map((p): ZfsPool => {
      const info = scrub[p.name];
      return {
        name: p.name,
        usedBytes: p.alloc,
        totalBytes: p.size,
        capacityFraction: p.size > 0 ? clamp(p.alloc / p.size, 0, 1) : 0,
        health: mapPoolHealth(p.health),
        lastScrubAt: info?.lastScrubAt ?? null,
        scrubErrors: info?.errors ?? 0,
      };
    }),
  };
}

// --- helper-API path (containerized deployments) ----------------------------

const collectorPoolSchema = z
  .object({
    name: z.string(),
    size: z.number(),
    alloc: z.number(),
    free: z.number().optional(),
    health: z.string(),
    lastScrubAt: z.number().nullable().optional(),
    scrubErrors: z.number().optional(),
  })
  .passthrough();

export const zfsCollectorSchema = z.object({
  pools: z.array(collectorPoolSchema),
});

/** Normalize the host-helper JSON payload into a `ZfsSnapshot`. */
export function normalizeZfsCollector(raw: unknown): ZfsSnapshot {
  const parsed = parseUpstream(zfsCollectorSchema, raw, "zfs.collector");
  return {
    pools: parsed.pools.map((p): ZfsPool => ({
      name: p.name,
      usedBytes: p.alloc,
      totalBytes: p.size,
      capacityFraction: p.size > 0 ? clamp(p.alloc / p.size, 0, 1) : 0,
      health: mapPoolHealth(p.health),
      lastScrubAt: p.lastScrubAt ?? null,
      scrubErrors: p.scrubErrors ?? 0,
    })),
  };
}

// --- connector factory ------------------------------------------------------

export function createZfsConnector(
  cfg: { pollIntervalMs: number },
  collect: (signal: AbortSignal) => Promise<ZfsSnapshot>,
): Connector<ZfsSnapshot> {
  return {
    id: "zfs",
    pollIntervalMs: cfg.pollIntervalMs,
    poll: (signal) => collect(signal),
  };
}
