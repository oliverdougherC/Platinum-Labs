/**
 * Database schema + migrations (PLA-179).
 *
 * Migrations are an ordered, append-only list applied idempotently via a
 * `schema_migrations` table (see migrate.ts). All timestamps are epoch
 * milliseconds in UTC — timezone-safe by construction (no local-time storage).
 *
 * This module is pure SQL text (no DB handle, no `server-only`) so migrations
 * are reviewable in source control and testable against an in-memory database.
 */

export interface Migration {
  id: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial",
    up: `
      -- High-frequency aggregate throughput samples (bytes/sec).
      CREATE TABLE IF NOT EXISTS throughput_samples (
        t   INTEGER NOT NULL,   -- epoch ms (UTC)
        bps INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_throughput_t ON throughput_samples (t);

      -- Per-pool storage usage samples (low cadence, long retention).
      CREATE TABLE IF NOT EXISTS storage_samples (
        t           INTEGER NOT NULL,
        pool        TEXT    NOT NULL,
        used_bytes  INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_storage_pool_t ON storage_samples (pool, t);

      -- Normalized cross-service activity events.
      CREATE TABLE IF NOT EXISTS activity_events (
        id       TEXT PRIMARY KEY,
        at       INTEGER NOT NULL,
        kind     TEXT    NOT NULL,
        severity TEXT    NOT NULL,
        source   TEXT    NOT NULL,
        message  TEXT    NOT NULL,
        subject  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_events (at);

      -- Connector health transitions (append on change).
      CREATE TABLE IF NOT EXISTS connector_health (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        at        INTEGER NOT NULL,
        connector TEXT    NOT NULL,
        status    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_health_at ON connector_health (at);

      -- Alert lifecycle records (one row per rule instance).
      CREATE TABLE IF NOT EXISTS alerts (
        rule_id     TEXT PRIMARY KEY,
        severity    TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        detail      TEXT    NOT NULL,
        source      TEXT    NOT NULL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts (last_seen);

      -- Optional action audit trail.
      CREATE TABLE IF NOT EXISTS action_audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        action TEXT    NOT NULL,
        result TEXT    NOT NULL,
        caller TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON action_audit (at);
    `,
  },
];
