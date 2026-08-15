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
import type { PoolHealth, ZfsPool, ZfsScanState, ZfsSnapshot } from "@/lib/types";

/** Map the parsed scrub/scan state onto the normalized model. */
function toScanState(state: ScrubState | undefined): ZfsScanState {
  switch (state) {
    case "in-progress":
      return "scrubbing";
    case "resilvering":
      return "resilvering";
    case "completed":
      return "finished";
    default:
      return "none";
  }
}

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
  /** zpool FRAG percent, when the listing included it. */
  frag: number | null;
}

/**
 * Parse `zpool list -Hp -o name,size,alloc,free,frag,health` output (also
 * accepts the pre-PLA-264 5-column form without `frag`). Tab-separated, exact
 * bytes, no header. Skips any line that doesn't have the expected numeric
 * columns (resilient to unexpected/partial output).
 */
export function parseZpoolList(stdout: string): RawPool[] {
  const pools: RawPool[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    const [name, size, alloc, free] = cols;
    // 6-column form carries FRAG before HEALTH; 5-column form has HEALTH last.
    const hasFrag = cols.length >= 6;
    const fragN = hasFrag ? Number(String(cols[4]).replace("%", "")) : Number.NaN;
    const health = hasFrag ? cols[5] : cols[4];
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
      frag: Number.isNaN(fragN) ? null : fragN,
    });
  }
  return pools;
}

export interface RawRootDataset {
  name: string;
  used: number;
  avail: number;
}

/**
 * Parse `zfs list -Hp -o name,used,avail -d 0` output: one line per root
 * dataset (dataset name === pool name), exact bytes.
 */
export function parseZfsList(stdout: string): Record<string, RawRootDataset> {
  const out: Record<string, RawRootDataset> = {};
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const [name, used, avail] = cols;
    const usedN = Number(used);
    const availN = Number(avail);
    if (!name || Number.isNaN(usedN) || Number.isNaN(availN)) continue;
    // Only root datasets: a nested dataset name contains "/".
    if (name.includes("/")) continue;
    out[name] = { name, used: usedN, avail: availN };
  }
  return out;
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

/**
 * Compose one normalized pool from the zpool allocation listing plus
 * (optionally) the root-dataset logical values. The HEADLINE used/total is
 * logical whenever datasets are known — zpool allocation size is never
 * presented as usable capacity (PLA-264), and never as installed raw device
 * capacity either (PLA-274). Allocation stays under `allocation` for detail
 * surfaces.
 */
export function composeZfsPool(
  p: RawPool,
  dataset: RawRootDataset | undefined,
  info: ScrubInfo | undefined,
): ZfsPool {
  const allocation = {
    sizeBytes: p.size,
    allocBytes: p.alloc,
    freeBytes: p.free,
    capFraction: p.size > 0 ? clamp(p.alloc / p.size, 0, 1) : 0,
    fragPercent: p.frag,
  };
  const logical =
    dataset !== undefined
      ? {
          usedBytes: dataset.used,
          availBytes: dataset.avail,
          totalBytes: dataset.used + dataset.avail,
          usedFraction:
            dataset.used + dataset.avail > 0
              ? clamp(dataset.used / (dataset.used + dataset.avail), 0, 1)
              : 0,
        }
      : null;
  const headline = logical ?? {
    usedBytes: allocation.allocBytes,
    availBytes: allocation.freeBytes,
    totalBytes: allocation.sizeBytes,
    usedFraction: allocation.capFraction,
  };
  return {
    name: p.name,
    usedBytes: headline.usedBytes,
    totalBytes: headline.totalBytes,
    capacityFraction: headline.usedFraction,
    capacityBasis: logical ? "logical" : "pool-allocation",
    allocation,
    logical,
    health: mapPoolHealth(p.health),
    scan: toScanState(info?.state),
    lastScrubAt: info?.lastScrubAt ?? null,
    scrubErrors: info?.errors ?? 0,
  };
}

/** Combine capacity + dataset + scrub info into the normalized snapshot. */
export function buildZfsSnapshot(
  pools: RawPool[],
  scrub: Record<string, ScrubInfo> = {},
  datasets: Record<string, RawRootDataset> = {},
): ZfsSnapshot {
  return {
    pools: pools.map((p) => composeZfsPool(p, datasets[p.name], scrub[p.name])),
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
    /** FRAG percent — added by the PLA-264 collector; absent on older sidecars. */
    frag: z.number().nullable().optional(),
    /** Root-dataset logical bytes — added by the PLA-264 collector. */
    logicalUsed: z.number().nullable().optional(),
    logicalAvail: z.number().nullable().optional(),
    scanState: z.enum(["none", "scrubbing", "resilvering", "finished"]).optional(),
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
    pools: parsed.pools.map((p): ZfsPool => {
      const raw: RawPool = {
        name: p.name,
        size: p.size,
        alloc: p.alloc,
        free: p.free ?? p.size - p.alloc,
        health: p.health,
        frag: p.frag ?? null,
      };
      const dataset =
        typeof p.logicalUsed === "number" && typeof p.logicalAvail === "number"
          ? { name: p.name, used: p.logicalUsed, avail: p.logicalAvail }
          : undefined;
      const pool = composeZfsPool(raw, dataset, undefined);
      // The helper reports scan state in the normalized vocabulary already.
      pool.scan = p.scanState ?? "none";
      pool.lastScrubAt = p.lastScrubAt ?? null;
      pool.scrubErrors = p.scrubErrors ?? 0;
      return pool;
    }),
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
