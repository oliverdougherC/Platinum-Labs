import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { deriveEvents } from "@/lib/pipeline/events";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { migrate } from "@/lib/db/migrate";
import { countRows, insertActivityEvent } from "@/lib/db/repository";
import type { DashboardSnapshot } from "@/lib/types";

const NOW = 1_754_000_000_000;

function snap(over: Partial<DashboardSnapshot>, generatedAt = NOW): DashboardSnapshot {
  const base = makeFakeSnapshot("idle", generatedAt);
  return { ...base, generatedAt, ...over };
}

describe("deriveEvents — baseline", () => {
  it("emits nothing for the first snapshot (no prev)", () => {
    expect(deriveEvents(null, makeFakeSnapshot("active", NOW))).toEqual([]);
  });

  it("emits nothing when nothing changed", () => {
    const s = makeFakeSnapshot("active", NOW);
    const s2 = { ...makeFakeSnapshot("active", NOW + 12_000), generatedAt: NOW + 12_000 };
    // active fixture is stable frame-to-frame → no transitions
    expect(deriveEvents(s, s2)).toEqual([]);
  });
});

describe("deriveEvents — determinism & dedup", () => {
  it("is deterministic: same pair → identical events & ids", () => {
    const a = makeFakeSnapshot("idle", NOW);
    const b = makeFakeSnapshot("active", NOW + 12_000);
    expect(deriveEvents(a, b)).toEqual(deriveEvents(a, b));
  });

  it("repeated derivation persists without duplicates (INSERT OR IGNORE)", () => {
    const db = new Database(":memory:");
    migrate(db);
    const a = makeFakeSnapshot("idle", NOW);
    const b = makeFakeSnapshot("active", NOW + 12_000);
    const events = deriveEvents(a, b);
    expect(events.length).toBeGreaterThan(0);
    // Persist twice — the second pass must not add rows.
    for (const e of events) insertActivityEvent(db, e);
    for (const e of events) insertActivityEvent(db, e);
    expect(countRows(db, "activity_events")).toBe(events.length);
    db.close();
  });
});

describe("deriveEvents — transitions", () => {
  it("playback started and stopped", () => {
    const idle = makeFakeSnapshot("idle", NOW);
    const playing = makeFakeSnapshot("direct-play", NOW + 12_000);
    const started = deriveEvents(idle, playing);
    expect(started.map((e) => e.kind)).toContain("playback.started");

    const stopped = deriveEvents(playing, makeFakeSnapshot("idle", NOW + 24_000));
    expect(stopped.map((e) => e.kind)).toContain("playback.stopped");
  });

  it("transfer stalled and failed", () => {
    const dl = makeFakeSnapshot("downloads", NOW);
    const stalled = makeFakeSnapshot("stalled", NOW + 12_000);
    const kinds = deriveEvents(dl, stalled).map((e) => e.kind);
    expect(kinds).toContain("transfer.stalled");
    expect(kinds).toContain("transfer.failed");
  });

  it("pool health change and scrub completion", () => {
    const healthy = snap({ zfs: { pools: [pool("tank", "ONLINE", NOW - 100)] } });
    const degraded = snap(
      { zfs: { pools: [pool("tank", "DEGRADED", NOW - 100)] } },
      NOW + 60_000,
    );
    expect(deriveEvents(healthy, degraded).map((e) => e.kind)).toContain(
      "pool.health.changed",
    );

    const scrubbed = snap(
      { zfs: { pools: [pool("tank", "ONLINE", NOW + 50_000)] } },
      NOW + 60_000,
    );
    expect(deriveEvents(healthy, scrubbed).map((e) => e.kind)).toContain(
      "zfs.scrub.completed",
    );
  });

  it("connector lost and recovered", () => {
    const ok = makeFakeSnapshot("idle", NOW);
    const down = makeFakeSnapshot("connector-unavailable", NOW + 12_000);
    expect(deriveEvents(ok, down).map((e) => e.kind)).toContain("connector.lost");
    expect(deriveEvents(down, ok).map((e) => e.kind)).toContain("connector.recovered");
  });
});

describe("deriveEvents — 24h simulation stays duplicate-free", () => {
  it("accumulates unique ids across many polls", () => {
    const scenarios = ["idle", "direct-play", "downloads", "stalled", "idle", "zfs-degraded"] as const;
    const seen = new Set<string>();
    let prev: DashboardSnapshot | null = null;
    let t = NOW;
    let duplicates = 0;
    // ~24h at 12s cadence would be 7200 polls; cycle scenarios to exercise transitions.
    for (let i = 0; i < 300; i++) {
      const scenario = scenarios[i % scenarios.length]!;
      const curr = makeFakeSnapshot(scenario, t);
      for (const e of deriveEvents(prev, curr)) {
        if (seen.has(e.id)) duplicates += 1;
        seen.add(e.id);
      }
      prev = curr;
      t += 12_000;
    }
    expect(duplicates).toBe(0);
    expect(seen.size).toBeGreaterThan(0);
  });
});

function pool(name: string, health: "ONLINE" | "DEGRADED", lastScrubAt: number) {
  const total = 20 * 1024 ** 4;
  const used = 12 * 1024 ** 4;
  return {
    name,
    usedBytes: used,
    totalBytes: total,
    capacityFraction: used / total,
    health: health as import("@/lib/types").PoolHealth,
    lastScrubAt,
    scrubErrors: 0,
  };
}
