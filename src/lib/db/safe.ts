/**
 * safePersist (PLA-179) — a persistence write must never crash the live
 * dashboard. Any error (disk full, locked/corrupt DB, closed handle) is
 * swallowed and reported to `onError`, and the caller continues serving data.
 *
 * Pure and DB-agnostic so the guarantee is unit-tested directly.
 */

import type { DB } from "@/lib/db/types";

export function safePersist(
  db: DB,
  fn: (db: DB) => void,
  onError?: (err: unknown) => void,
): boolean {
  try {
    fn(db);
    return true;
  } catch (err) {
    onError?.(err);
    return false;
  }
}
