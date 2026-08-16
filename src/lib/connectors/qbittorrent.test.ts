import { describe, expect, it } from "vitest";
import {
  createQbittorrentConnector,
  mapQbState,
  normalizeQbittorrent,
  type QbClient,
} from "@/lib/connectors/qbittorrent";
import { ConnectorValidationError } from "@/lib/connectors/connector";
import { opaqueId } from "@/lib/utils";

describe("mapQbState", () => {
  it("distinguishes truly stalled (0 speed) from slow-but-moving", () => {
    expect(mapQbState("stalledDL", 0)).toBe("stalled");
    expect(mapQbState("stalledDL", 50_000)).toBe("downloading"); // slow, not stalled
    expect(mapQbState("stalledDL", null)).toBe("stalled");
  });
  it("maps errors, downloads, waiting, and seeding", () => {
    expect(mapQbState("error", 0)).toBe("failed");
    expect(mapQbState("missingFiles", 0)).toBe("failed");
    expect(mapQbState("downloading", 100)).toBe("downloading");
    expect(mapQbState("pausedDL", 0)).toBe("searching");
    expect(mapQbState("metaDL", 0)).toBe("searching");
    expect(mapQbState("uploading", 0)).toBe("completed");
  });
});

const TORRENTS = [
  { hash: "a", name: "Severance.S02E07.1080p", progress: 0.63, dlspeed: 7_500_000, eta: 320, state: "downloading", save_path: "/secret/path", tracker: "http://private.tracker/announce" },
  { hash: "b", name: "Sinners.2025.2160p", progress: 0.18, dlspeed: 0, eta: 8_640_000, state: "stalledDL" },
  { hash: "c", name: "ubuntu.iso", progress: 0.04, dlspeed: 0, eta: 8_640_000, state: "error" },
];

describe("normalizeQbittorrent", () => {
  it("emits only pipeline fields and never tracker/path metadata", () => {
    const snap = normalizeQbittorrent({ torrents: TORRENTS, transfer: { dl_info_speed: 7_500_000 } });
    expect(snap.items).toHaveLength(3);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("secret/path");
    expect(serialized).not.toContain("private.tracker");
  });

  it("normalizes progress/rate/eta/state and the rollup", () => {
    const snap = normalizeQbittorrent({ torrents: TORRENTS, transfer: { dl_info_speed: 7_500_000 } });
    const a = snap.items[0]!;
    expect(a.title).toBe("Severance.S02E07.1080p");
    expect(a.state).toBe("downloading");
    expect(a.progress).toBeCloseTo(0.63, 5);
    expect(a.rateBps).toBe(7_500_000);
    expect(a.etaSeconds).toBe(320);
    // infinity eta becomes null
    expect(snap.items[1]!.etaSeconds).toBeNull();
    expect(snap.rollup.downloading).toBe(1);
    expect(snap.rollup.failedOrStalled).toBe(2); // stalled + error
    expect(snap.rollup.aggregateRateBps).toBe(7_500_000);
  });

  it("keeps explicit zero rates as zero but leaves omitted per-item rates unknown", () => {
    const snap = normalizeQbittorrent({
      torrents: [
        { hash: "zero", name: "Zero", progress: 0.2, dlspeed: 0, eta: 120, state: "downloading" },
        { hash: "missing", name: "Missing", progress: 0.4, eta: 240, state: "downloading" },
      ],
    });
    expect(snap.items[0]!.rateBps).toBe(0);
    expect(snap.items[1]!.rateBps).toBeNull();
    expect(snap.rollup.aggregateRateBps).toBeNull();
  });

  it("preserves explicit global zeroes and does not backfill unknown upload with zero", () => {
    const snap = normalizeQbittorrent({
      torrents: [
        { hash: "seeding", name: "Seeding", progress: 1, upspeed: 0, state: "uploading" },
        { hash: "unknown", name: "Unknown", progress: 1, state: "uploading" },
      ],
      transfer: { dl_info_speed: 0, up_info_speed: 0 },
    });
    expect(snap.rollup.aggregateRateBps).toBe(0);
    expect(snap.rollup.uploadRateBps).toBe(0);
    expect(snap.rollup.seeding).toBe(0);

    const unknownUpload = normalizeQbittorrent({
      torrents: [{ hash: "unknown", name: "Unknown", progress: 1, state: "uploading" }],
    });
    expect(unknownUpload.rollup.uploadRateBps).toBeNull();
  });

  it("counts only actively uploading torrents as seeding", () => {
    const snap = normalizeQbittorrent({
      torrents: [
        { hash: "active", name: "Active", progress: 1, upspeed: 1_000, state: "uploading" },
        { hash: "idle", name: "Idle", progress: 1, upspeed: 0, state: "stalledUP" },
        { hash: "unknown", name: "Unknown", progress: 1, state: "forcedUP" },
      ],
    });
    expect(snap.rollup.seeding).toBe(1);
    expect(snap.rollup.uploadRateBps).toBe(1_000);
  });

  it("uses an opaque id/correlation key and never exposes the raw infohash", () => {
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    const snap = normalizeQbittorrent({ torrents: [{ hash, name: "X", progress: 0.5, dlspeed: 1, eta: 60, state: "downloading" }] });
    const item = snap.items[0]!;
    const key = opaqueId(hash);
    expect(item.id).toBe(`qbittorrent-${key}`);
    expect(item.correlationKey).toBe(key);
    expect(JSON.stringify(snap)).not.toContain(hash); // raw infohash never leaks
  });

  it("empty torrent list → empty snapshot", () => {
    const snap = normalizeQbittorrent({ torrents: [] });
    expect(snap.items).toHaveLength(0);
    expect(snap.rollup.aggregateRateBps).toBe(0);
  });

  it("rejects malformed data", () => {
    expect(() => normalizeQbittorrent({ torrents: { not: "an array" } })).toThrow(
      ConnectorValidationError,
    );
  });
});

describe("createQbittorrentConnector", () => {
  it("polls torrents + transfer via the injected client", async () => {
    const client: QbClient = {
      torrentsInfo: async () => TORRENTS,
      transferInfo: async () => ({ dl_info_speed: 7_500_000 }),
    };
    const connector = createQbittorrentConnector({ pollIntervalMs: 10_000 }, client);
    expect(connector.id).toBe("qbittorrent");
    const snap = await connector.poll(new AbortController().signal);
    expect(snap.items).toHaveLength(3);
  });
});
