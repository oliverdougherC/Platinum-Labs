/**
 * Shared DB type alias (PLA-179).
 *
 * A type-only reference to better-sqlite3's instance type. Using `import(...)`
 * type syntax keeps this erasable — no runtime import of the native module — so
 * the DB-agnostic core (migrate/repository/retention) type-checks and unit-tests
 * against an in-memory database without pulling native code into unrelated
 * bundles.
 */
export type DB = import("better-sqlite3").Database;
