import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/attention/engine";
import { detectConditions, RULE } from "@/lib/attention/rules";
import { appConfig } from "@/lib/config";
import { correlateAcquisition } from "@/lib/dashboard/aggregate";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";
import { deriveEvents } from "@/lib/pipeline/events";
import type { AcquisitionItem, DashboardSnapshot } from "@/lib/types";

const T0 = 1_754_000_000_000;
const KEY = "opaque-correlation-key";

function item(source: AcquisitionItem["source"], state: AcquisitionItem["state"]): AcquisitionItem {
  return {
    id: `${source}-source-specific-id`,
    source,
    title: source === "qbittorrent" ? "Opaque.Release.Name" : "Example title",
    quality: source === "qbittorrent" ? null : "WEB-DL 1080p",
    state,
    progress: state === "completed" ? 1 : 0.5,
    rateBps: source === "qbittorrent" ? 1_000 : null,
    etaSeconds: state === "completed" ? 0 : 60,
    correlationKey: KEY,
  };
}

function snapshot(at: number, items: AcquisitionItem[]): DashboardSnapshot {
  return {
    ...makeFakeSnapshot("idle", at),
    generatedAt: at,
    acquisition: {
      items: correlateAcquisition(items),
      rollup: { downloading: 0, importing: 0, failedOrStalled: 0, aggregateRateBps: 0 },
    },
  };
}

describe("temporal acquisition identity", () => {
  it("keeps one canonical opaque id through qB-only, correlated, Servarr-only, and correlated snapshots", () => {
    const sequence = [
      correlateAcquisition([item("qbittorrent", "downloading")]),
      correlateAcquisition([item("qbittorrent", "downloading"), item("sonarr", "downloading")]),
      correlateAcquisition([item("sonarr", "downloading")]),
      correlateAcquisition([item("qbittorrent", "downloading"), item("sonarr", "downloading")]),
      correlateAcquisition([item("radarr", "downloading")]),
    ];

    expect(sequence.flatMap((items) => items.map((i) => i.id))).toEqual(
      Array(5).fill(`acq-${KEY}`),
    );
    expect(JSON.stringify(sequence)).not.toContain("raw-infohash-secret");
  });

  it("does not emit duplicate starts when reporting sources join, leave, and rejoin", () => {
    const sequence = [
      snapshot(T0, []),
      snapshot(T0 + 1_000, [item("qbittorrent", "downloading")]),
      snapshot(T0 + 2_000, [item("qbittorrent", "downloading"), item("sonarr", "downloading")]),
      snapshot(T0 + 3_000, [item("sonarr", "downloading")]),
      snapshot(T0 + 4_000, [item("qbittorrent", "downloading"), item("sonarr", "downloading")]),
      snapshot(T0 + 5_000, [item("sonarr", "completed")]),
    ];
    const events = sequence.slice(1).flatMap((curr, i) => deriveEvents(sequence[i]!, curr));

    expect(events.filter((e) => e.kind === "download.started")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "transfer.completed")).toHaveLength(1);
    expect(new Set(events.map((e) => e.subject))).toEqual(new Set([`acq-${KEY}`]));
  });

  it("preserves stalled alert identity and grace while source membership changes", () => {
    const stalledSets = [
      correlateAcquisition([item("qbittorrent", "stalled")]),
      correlateAcquisition([item("qbittorrent", "stalled"), item("sonarr", "downloading")]),
      correlateAcquisition([item("sonarr", "stalled")]),
    ];
    const timings = {
      [RULE.transferStalled]: { graceMs: 60_000, clearMs: 60_000 },
    };
    let states = new Map();
    for (const [index, acquisition] of stalledSets.entries()) {
      const conditions = detectConditions({
        health: [], pools: [], acquisition, thresholds: appConfig.thresholds,
      });
      expect(conditions.map((c) => c.alertId)).toEqual([
        `${RULE.transferStalled}:acq-${KEY}`,
      ]);
      const result = evaluate(states, conditions, timings, T0 + index * 30_000);
      states = result.states;
    }
    const active = [...states.values()].filter((state) => state.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.firstObservedAt).toBe(T0);
    expect(active[0]!.firstSeenAt).toBe(T0 + 60_000);
  });
});
