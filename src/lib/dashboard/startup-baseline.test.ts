import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveEvents } from "@/lib/pipeline/events";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { testTelemetry } from "@/lib/test/factories";
import type { DashboardSnapshot } from "@/lib/types";

/**
 * Phase 1.2 — startup must establish a SILENT event baseline. A boot must never
 * emit false "started"/"recovered"/"pool-health-changed"/"download-started"
 * events simply because the process came up and the first real data arrived.
 */

describe("startup event baseline — no false events on boot", () => {
  it("the first real observation (even a busy one) emits nothing", () => {
    // A boot where playback is already in progress, downloads are active, and a
    // pool exists. Because this is the baseline (prev = null), zero events fire.
    const boot = makeFakeSnapshot("attention", 1_754_000_000_000);
    expect(deriveEvents(null, boot)).toEqual([]);
  });

  it("does NOT treat 'empty -> first real data' as a wave of started events", () => {
    // This reproduces the OLD bug: an empty snapshot used as the baseline would
    // make the first real poll look like everything just started/recovered.
    const empty: DashboardSnapshot = {
      mode: "live",
      generatedAt: 1_000,
      health: [],
      jellyfin: { serverAvailable: false, version: null, sessions: [], lastPlaybackAt: null },
      acquisition: { items: [], rollup: { downloading: 0, importing: 0, failedOrStalled: 0, aggregateRateBps: 0 } },
      zfs: { pools: [] },
      telemetry: testTelemetry(),
      attention: [],
      activity: [],
    };
    const firstReal = makeFakeSnapshot("active", 2_000);

    // The buggy path (empty baseline) WOULD emit a bunch of spurious events...
    const buggy = deriveEvents(empty, firstReal);
    expect(buggy.length).toBeGreaterThan(0); // demonstrates why an empty baseline is wrong

    // ...but the fixed startup uses the first real observation as the baseline,
    // which is silent.
    expect(deriveEvents(null, firstReal)).toEqual([]);
  });

  it("only a genuine post-baseline transition produces an event", () => {
    const t0 = 1_754_000_000_000;
    const baseline = makeFakeSnapshot("idle", t0); // no sessions
    const nowPlaying = makeFakeSnapshot("direct-play", t0 + 12_000); // one session

    expect(deriveEvents(null, baseline)).toEqual([]); // baseline: silent
    const events = deriveEvents(baseline, nowPlaying);
    expect(events.some((e) => e.kind === "playback.started")).toBe(true);
  });
});

describe("live registry init — clean boot with no connectors configured", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "homelab-boot-"));
    process.env.HOMELAB_DATA_MODE = "live";
    process.env.HOMELAB_DB_PATH = join(dir, "boot.db");
    // Ensure no connectors are configured.
    for (const k of [
      "JELLYFIN_URL", "JELLYFIN_API_KEY", "SONARR_URL", "SONARR_API_KEY",
      "RADARR_URL", "RADARR_API_KEY", "QBITTORRENT_URL", "QBITTORRENT_USERNAME",
      "QBITTORRENT_PASSWORD", "ZFS_COLLECTOR_URL", "ZFS_COLLECTOR_TOKEN", "HOMELAB_ZFS_COMMAND",
    ]) {
      delete process.env[k];
    }
  });

  afterEach(async () => {
    const registry = await import("@/lib/dashboard/registry.server");
    registry.__resetLiveRegistryForTests();
    const { closeDb } = await import("@/lib/db/db.server");
    closeDb();
    const { resetServerEnvCache } = await import("@/lib/env.server");
    resetServerEnvCache();
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots to a valid partial snapshot representing all six connectors, with no activity", async () => {
    const { resetServerEnvCache } = await import("@/lib/env.server");
    resetServerEnvCache();
    const { getLiveSnapshot } = await import("@/lib/dashboard/registry.server");

    const snap = await getLiveSnapshot();
    expect(snap.mode).toBe("live");
    expect(snap.health.map((h) => h.id).sort()).toEqual(
      ["host", "jellyfin", "qbittorrent", "radarr", "sonarr", "zfs"],
    );
    // No connectors configured → every record is not-configured, none "healthy".
    expect(snap.health.every((h) => h.configured === false)).toBe(true);
    // A clean boot emits no activity events.
    expect(snap.activity).toEqual([]);

    // A second call returns the cached snapshot without re-initializing or throwing.
    const again = await getLiveSnapshot();
    expect(again.mode).toBe("live");
  });
});
