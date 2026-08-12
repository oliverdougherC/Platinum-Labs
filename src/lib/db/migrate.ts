/**
 * Idempotent migration runner (PLA-179).
 *
 * Applies any unapplied migrations from `MIGRATIONS` inside a transaction and
 * records them in `schema_migrations`. Safe to call on every boot: a fresh
 * database is created cleanly, and an up-to-date one is a no-op.
 */

import { MIGRATIONS } from "@/lib/db/schema";
import type { DB } from "@/lib/db/types";

export function migrate(db: DB): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => (row as { id: number }).id),
  );

  const record = db.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );

  let count = 0;
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id)).sort(
    (a, b) => a.id - b.id,
  );

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.up);
      // applied_at is informational; epoch ms is fine to compute here.
      record.run(migration.id, migration.name, Date.now());
    });
    run();
    count += 1;
  }

  return count;
}
