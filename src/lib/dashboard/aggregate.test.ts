import { describe, expect, it } from "vitest";
import {
  assembleSnapshot,
  correlateAcquisition,
  fillConnectorHealth,
  filterAcquisitionForDisplay,
  mergeAcquisition,
  CORE_CONNECTORS,
  type ConnectorConfigStatus,
} from "@/lib/dashboard/aggregate";
import type {
  AcquisitionItem,
  AcquisitionSnapshot,
  ConnectorHealth,
  ConnectorId,
} from "@/lib/types";

function acqItem(over: Partial<AcquisitionItem> = {}): AcquisitionItem {
  return {
    id: "i",
    source: "sonarr",
    title: "T",
    quality: null,
    state: "downloading",
    progress: 0.5,
    rateBps: null,
    etaSeconds: null,
    ...over,
  };
}

const NOW = 1_754_000_000_000;

function health(id: ConnectorHealth["id"], status: ConnectorHealth["status"]): ConnectorHealth {
  return { id, status, configured: true, lastSuccessAt: NOW, lastError: null, configError: null, pollIntervalMs: 10_000 };
}

function configStatus(
  overrides: Partial<Record<ConnectorId, ConnectorConfigStatus>> = {},
): Record<ConnectorId, ConnectorConfigStatus> {
  const base = {} as Record<ConnectorId, ConnectorConfigStatus>;
  for (const id of CORE_CONNECTORS) {
    base[id] = { configured: false, configError: null, pollIntervalMs: 10_000 };
  }
  return { ...base, ...overrides };
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

describe("correlateAcquisition — cross-service correlation (exact identifiers only)", () => {
  it("merges the same download (Servarr + qB) into one row: identity from Servarr, telemetry from qB", () => {
    const servarr = acqItem({
      id: "sonarr-1", source: "sonarr", title: "Severance — S02E07",
      quality: "WEB-DL 1080p", state: "downloading", progress: 0.6, correlationKey: "K",
    });
    const qb = acqItem({
      id: "qbittorrent-K", source: "qbittorrent", title: "Severance.S02E07.1080p.WEB-DL",
      state: "downloading", progress: 0.63, rateBps: 7_500_000, etaSeconds: 320, correlationKey: "K",
    });
    const merged = correlateAcquisition([servarr, qb]);
    expect(merged).toHaveLength(1);
    const m = merged[0]!;
    expect(m.id).toBe("acq-K");
    expect(m.title).toBe("Severance — S02E07"); // Servarr media identity
    expect(m.quality).toBe("WEB-DL 1080p");
    expect(m.rateBps).toBe(7_500_000); // qB transfer telemetry
    expect(m.etaSeconds).toBe(320);
    expect(m.progress).toBeCloseTo(0.63, 5); // qB progress (more current)
  });

  it("leaves Sonarr-only, Radarr-only, and qB-only items unmerged", () => {
    expect(correlateAcquisition([acqItem({ id: "sonarr-1", source: "sonarr", correlationKey: "A" })])).toHaveLength(1);
    expect(correlateAcquisition([acqItem({ id: "radarr-1", source: "radarr", correlationKey: "B" })])).toHaveLength(1);
    expect(correlateAcquisition([acqItem({ id: "qbittorrent-C", source: "qbittorrent", correlationKey: "C" })])[0]!.id).toBe("qbittorrent-C");
  });

  it("keeps items with mismatched identifiers separate", () => {
    const merged = correlateAcquisition([
      acqItem({ id: "sonarr-1", source: "sonarr", correlationKey: "A" }),
      acqItem({ id: "qbittorrent-B", source: "qbittorrent", correlationKey: "B" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("never fuzzily merges two same-titled items that lack a shared key", () => {
    const merged = correlateAcquisition([
      acqItem({ id: "sonarr-1", source: "sonarr", title: "The Movie (2025)" }),
      acqItem({ id: "sonarr-2", source: "sonarr", title: "The Movie (2025)" }),
    ]);
    expect(merged).toHaveLength(2); // identical titles, no correlationKey → stay separate
  });

  it("stalled qB correlated with a downloading Servarr item → stalled wins", () => {
    const merged = correlateAcquisition([
      acqItem({ id: "sonarr-1", source: "sonarr", state: "downloading", correlationKey: "K" }),
      acqItem({ id: "qbittorrent-K", source: "qbittorrent", state: "stalled", rateBps: 0, progress: 0.2, correlationKey: "K" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.state).toBe("stalled");
  });

  it("importing Servarr correlated with completed qB → importing wins", () => {
    const merged = correlateAcquisition([
      acqItem({ id: "sonarr-1", source: "sonarr", state: "importing", progress: 1, correlationKey: "K" }),
      acqItem({ id: "qbittorrent-K", source: "qbittorrent", state: "completed", progress: 1, correlationKey: "K" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.state).toBe("importing");
  });

  it("mergeAcquisition rollup counts a correlated pair once", () => {
    const merged = mergeAcquisition(
      [acqItem({ id: "sonarr-1", source: "sonarr", state: "downloading", correlationKey: "K" })],
      null,
      { items: [acqItem({ id: "qbittorrent-K", source: "qbittorrent", state: "downloading", rateBps: 5_000_000, correlationKey: "K" })], rollup: { downloading: 1, importing: 0, failedOrStalled: 0, aggregateRateBps: 5_000_000 } },
    );
    expect(merged.items).toHaveLength(1); // one coherent acquisition
    expect(merged.rollup.downloading).toBe(1);
    expect(merged.rollup.aggregateRateBps).toBe(5_000_000);
  });
});

describe("filterAcquisitionForDisplay — active/relevant browser set", () => {
  it("drops completed/seeding items and orders by attention priority", () => {
    const acq = mergeAcquisition(
      [
        acqItem({ id: "c", source: "sonarr", state: "completed" }),
        acqItem({ id: "d", source: "sonarr", state: "downloading" }),
        acqItem({ id: "st", source: "sonarr", state: "stalled" }),
      ],
      null,
      null,
    );
    const disp = filterAcquisitionForDisplay(acq);
    expect(disp.items.map((i) => i.id)).toEqual(["st", "d"]); // completed dropped; stalled first
    expect(disp.rollup).toEqual(acq.rollup); // rollup preserved (completed never counted)
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

describe("fillConnectorHealth — every connector represented", () => {
  it("emits a record for all five core connectors even when none are live", () => {
    const filled = fillConnectorHealth([], configStatus());
    expect(filled.map((h) => h.id).sort()).toEqual(
      [...CORE_CONNECTORS].sort(),
    );
    expect(filled.every((h) => h.configured === false)).toBe(true);
  });

  it("keeps live health and fills the rest", () => {
    const filled = fillConnectorHealth(
      [health("jellyfin", "healthy")],
      configStatus(),
    );
    const jf = filled.find((h) => h.id === "jellyfin")!;
    expect(jf.status).toBe("healthy");
    expect(jf.configured).toBe(true);
    // An absent connector is present but flagged not-configured (never "healthy empty").
    const zfs = filled.find((h) => h.id === "zfs")!;
    expect(zfs.configured).toBe(false);
    expect(zfs.status).toBe("unavailable");
  });

  it("surfaces a misconfiguration as configError without a configured flag", () => {
    const filled = fillConnectorHealth(
      [],
      configStatus({
        sonarr: { configured: false, configError: "missing SONARR_API_KEY", pollIntervalMs: 25_000 },
      }),
    );
    const sonarr = filled.find((h) => h.id === "sonarr")!;
    expect(sonarr.configured).toBe(false);
    expect(sonarr.configError).toBe("missing SONARR_API_KEY");
  });
});
