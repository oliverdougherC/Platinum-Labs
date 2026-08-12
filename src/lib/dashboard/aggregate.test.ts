import { describe, expect, it } from "vitest";
import { assembleSnapshot, mergeAcquisition } from "@/lib/dashboard/aggregate";
import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  ConnectorHealth,
} from "@/lib/types";

const NOW = 1_754_000_000_000;

function health(id: ConnectorHealth["id"], status: ConnectorHealth["status"]): ConnectorHealth {
  return { id, status, configured: true, lastSuccessAt: NOW, lastError: null, pollIntervalMs: 10_000 };
}

const sonarrItem: AcquisitionItem = {
  id: "sonarr-1",
  source: "sonarr",
  title: "Severance — S02E07",
  quality: "WEB-DL 1080p",
  state: "downloading",
  progress: 0.6,
  rateBps: null,
  etaSeconds: 300,
};

const qb: AcquisitionSnapshot = {
  items: [
    { id: "qbittorrent-a", source: "qbittorrent", title: "x", quality: null, state: "stalled", progress: 0.1, rateBps: 0, etaSeconds: null },
  ],
  rollup: { downloading: 0, importing: 0, failedOrStalled: 1, aggregateRateBps: 5_000_000 },
};

describe("mergeAcquisition", () => {
  it("merges items from all sources and recomputes the rollup", () => {
    const merged = mergeAcquisition([sonarrItem], null, qb);
    expect(merged.items).toHaveLength(2);
    expect(merged.rollup.downloading).toBe(1);
    expect(merged.rollup.failedOrStalled).toBe(1);
    // qBittorrent global rate is authoritative
    expect(merged.rollup.aggregateRateBps).toBe(5_000_000);
  });

  it("handles all-null sources", () => {
    const merged = mergeAcquisition(null, null, null);
    expect(merged.items).toEqual([]);
    expect(merged.rollup.aggregateRateBps).toBe(0);
  });
});

describe("assembleSnapshot — partial responses", () => {
  it("produces a valid snapshot when connectors are unavailable (no throw)", () => {
    const snap = assembleSnapshot({
      now: NOW,
      health: [health("jellyfin", "unavailable"), health("zfs", "healthy")],
      jellyfin: null, // unavailable
      sonarr: [sonarrItem],
      radarr: null,
      qbittorrent: null,
      zfs: { pools: [] },
    });
    expect(snap.mode).toBe("live");
    expect(snap.jellyfin.serverAvailable).toBe(false); // graceful fallback
    expect(snap.acquisition.items).toHaveLength(1); // partial healthy data present
    expect(snap.zfs.pools).toEqual([]);
    expect(snap.generatedAt).toBe(NOW);
  });

  it("passes through health, attention, activity, and history", () => {
    const snap = assembleSnapshot({
      now: NOW,
      health: [health("sonarr", "healthy")],
      jellyfin: { serverAvailable: true, version: "10.9", sessions: [], lastPlaybackAt: null },
      sonarr: [],
      radarr: [],
      qbittorrent: null,
      zfs: { pools: [] },
      history: { throughput: [{ t: NOW, bps: 1 }], storageSeries: [], storage: [] },
    });
    expect(snap.health).toHaveLength(1);
    expect(snap.history?.throughput).toHaveLength(1);
  });
});
