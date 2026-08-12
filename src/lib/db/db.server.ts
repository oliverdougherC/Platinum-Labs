import "server-only";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "@/lib/db/migrate";
import { safePersist } from "@/lib/db/safe";
import { getServerEnv } from "@/lib/env.server";
import type { DB } from "@/lib/db/types";

/**
 * Server-only database opener + singleton (PLA-179).
 *
 * Opens the on-disk SQLite database (WAL for concurrent read while polling),
 * runs migrations on boot, and hands out a shared handle. `tryPersist` wraps
 * every write so a persistence failure is logged but never propagates into the
 * request/render path.
 */
let handle: DB | null = null;

function dbPath(): string {
  // Single typed source of truth; falls back to the default if env is unreadable.
  try {
    return getServerEnv().HOMELAB_DB_PATH;
  } catch {
    return process.env.HOMELAB_DB_PATH ?? "./data/homelab.db";
  }
}

export function getDb(): DB {
  if (handle) return handle;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  handle = db;
  return handle;
}

/** Run a write against the DB, swallowing any failure (never crashes render). */
export function tryPersist(fn: (db: DB) => void): boolean {
  let db: DB;
  try {
    db = getDb();
  } catch (err) {
    console.error("[db] open failed:", err instanceof Error ? err.message : err);
    return false;
  }
  return safePersist(db, fn, (err) =>
    console.error("[db] write failed:", err instanceof Error ? err.message : err),
  );
}

/** For tests/shutdown: close and reset the singleton. */
export function closeDb(): void {
  handle?.close();
  handle = null;
}
