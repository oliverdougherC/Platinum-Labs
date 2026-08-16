import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConnectorError } from "@/lib/connectors/connector";
import { fetchJson } from "@/lib/connectors/http";
import {
  buildZfsSnapshot,
  normalizeZfsCollector,
  parseZfsList,
  parseZpoolList,
  parseZpoolStatus,
} from "@/lib/connectors/zfs";
import type { ZfsSnapshot } from "@/lib/types";

const execFileP = promisify(execFile);

/**
 * Safe ZFS collectors (PLA-184) — `server-only`.
 *
 * `makeCommandCollect` executes a FIXED argv with no shell and no interpolation
 * of any request/browser input — the only way the dashboard touches `zpool`.
 * `makeHelperCollect` is the containerized alternative: it consumes a minimal
 * host-side helper API instead of needing ZFS access inside the container.
 */
export function makeCommandCollect(
  timeoutMs = 8_000,
): (signal: AbortSignal) => Promise<ZfsSnapshot> {
  return async (signal) => {
    try {
      const [list, status, datasets] = await Promise.all([
        execFileP(
          "zpool",
          ["list", "-Hp", "-o", "name,size,alloc,free,frag,health"],
          { signal, timeout: timeoutMs },
        ),
        execFileP("zpool", ["status"], { signal, timeout: timeoutMs }),
        // Root datasets only (-d 0): logical USED/AVAIL — the user-facing
        // capacity. Best-effort: a failure degrades to physical-only display
        // rather than failing the poll.
        execFileP("zfs", ["list", "-Hp", "-o", "name,used,avail", "-d", "0"], {
          signal,
          timeout: timeoutMs,
        }).catch(() => ({ stdout: "" })),
      ]);
      return buildZfsSnapshot(
        parseZpoolList(list.stdout),
        parseZpoolStatus(status.stdout),
        parseZfsList(datasets.stdout),
      );
    } catch {
      // Missing binary, no permission, or timeout — surface a sanitized error.
      throw new ConnectorError("zpool command unavailable");
    }
  };
}

export function makeHelperCollect(
  url: string,
  token: string | undefined,
): (signal: AbortSignal) => Promise<ZfsSnapshot> {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return async (signal) => {
    const raw = await fetchJson(url, { signal, headers, label: "zfs" });
    return normalizeZfsCollector(raw);
  };
}
