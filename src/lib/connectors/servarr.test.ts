import { describe, expect, it } from "vitest";
import {
  collectServarrHistory,
  createRadarrConnector,
  createSonarrConnector,
  mapServarrState,
  normalizeServarrHistory,
  normalizeServarrQueue,
  parseTimeleft,
} from "@/lib/connectors/servarr";
import { ConnectorError, ConnectorValidationError } from "@/lib/connectors/connector";
import { opaqueId } from "@/lib/utils";
import type { HttpGet } from "@/lib/connectors/jellyfin";

describe("parseTimeleft", () => {
  it("parses hh:mm:ss and d.hh:mm:ss", () => {
    expect(parseTimeleft("00:05:20")).toBe(320);
    expect(parseTimeleft("01:00:00")).toBe(3600);
    expect(parseTimeleft("1.00:05:20")).toBe(86_720);
    expect(parseTimeleft(undefined)).toBeNull();
    expect(parseTimeleft("garbage")).toBeNull();
  });
});

describe("mapServarrState", () => {
  it("maps statuses to normalized states", () => {
    expect(mapServarrState({ status: "downloading", trackedDownloadState: "downloading" })).toBe("downloading");
    expect(mapServarrState({ trackedDownloadState: "importing" })).toBe("importing");
    expect(mapServarrState({ status: "completed", trackedDownloadState: "imported" })).toBe("completed");
    expect(mapServarrState({ status: "warning" })).toBe("stalled");
    expect(mapServarrState({ status: "failed" })).toBe("failed");
    expect(mapServarrState({ trackedDownloadStatus: "error" })).toBe("failed");
    expect(mapServarrState({ status: "queued" })).toBe("searching");
  });
});

const SONARR_QUEUE = {
  records: [
    {
      id: 11,
      status: "downloading",
      trackedDownloadState: "downloading",
      size: 1000,
      sizeleft: 370,
      timeleft: "00:05:20",
      quality: { quality: { name: "WEB-DL 1080p" } },
      series: { title: "Severance" },
      episode: { seasonNumber: 2, episodeNumber: 7, title: "Chikhai Bardo" },
    },
    {
      id: 12,
      status: "warning",
      trackedDownloadState: "stalled",
      size: 1000,
      sizeleft: 800,
      series: { title: "Andor" },
      episode: { seasonNumber: 2, episodeNumber: 4 },
    },
  ],
};

describe("normalizeServarrQueue (Sonarr)", () => {
  it("normalizes episodes with SxxEyy titles, quality, progress, ETA, state", () => {
    const items = normalizeServarrQueue(SONARR_QUEUE, "sonarr");
    expect(items).toHaveLength(2);
    const a = items[0]!;
    expect(a.source).toBe("sonarr");
    expect(a.title).toBe("Severance — S02E07");
    expect(a.quality).toBe("WEB-DL 1080p");
    expect(a.state).toBe("downloading");
    expect(a.progress).toBeCloseTo(0.63, 5);
    expect(a.etaSeconds).toBe(320);
    expect(items[1]!.state).toBe("stalled");
  });

  it("empty queue → no items", () => {
    expect(normalizeServarrQueue({ records: [] }, "sonarr")).toEqual([]);
    expect(normalizeServarrQueue({}, "sonarr")).toEqual([]); // missing records
  });

  it("rejects malformed data", () => {
    expect(() => normalizeServarrQueue({ records: "nope" }, "sonarr")).toThrow(
      ConnectorValidationError,
    );
  });
});

describe("normalizeServarrQueue (Radarr)", () => {
  it("uses movie titles", () => {
    const items = normalizeServarrQueue(
      { records: [{ id: 5, status: "downloading", trackedDownloadState: "downloading", size: 100, sizeleft: 10, movie: { title: "Sinners (2025)" } }] },
      "radarr",
    );
    expect(items[0]!.title).toBe("Sinners (2025)");
    expect(items[0]!.source).toBe("radarr");
    expect(items[0]!.progress).toBeCloseTo(0.9, 5);
  });
});

describe("normalizeServarrQueue — correlation key", () => {
  it("derives an opaque correlation key from downloadId (never the raw infohash)", () => {
    const hash = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const items = normalizeServarrQueue(
      { records: [{ id: 9, status: "downloading", trackedDownloadState: "downloading", size: 1, sizeleft: 0, downloadId: hash, series: { title: "X" }, episode: { seasonNumber: 1, episodeNumber: 1 } }] },
      "sonarr",
    );
    const key = items[0]!.correlationKey!;
    expect(key).toBe(opaqueId(hash.toLowerCase()));
    // The raw infohash must not appear anywhere in the serialized item.
    expect(JSON.stringify(items[0])).not.toContain(hash);
    expect(JSON.stringify(items[0])).not.toContain(hash.toLowerCase());
  });

  it("leaves correlationKey null for a queue item with no downloadId (e.g. usenet)", () => {
    const items = normalizeServarrQueue(
      { records: [{ id: 1, status: "downloading", size: 1, sizeleft: 0, series: { title: "X" } }] },
      "sonarr",
    );
    expect(items[0]!.correlationKey ?? null).toBeNull();
  });
});

// --- history ----------------------------------------------------------------

const SONARR_HISTORY_PAGE = {
  page: 1,
  pageSize: 50,
  totalRecords: 3,
  records: [
    {
      id: 501,
      date: "2026-08-12T11:00:00.000Z",
      eventType: "downloadFolderImported",
      downloadId: "ABC123",
      series: { title: "Severance" },
      episode: { seasonNumber: 2, episodeNumber: 7 },
      quality: { quality: { name: "WEB-DL 1080p" } },
    },
    {
      id: 502,
      date: "2026-08-12T10:30:00.000Z",
      eventType: "downloadFailed",
      sourceTitle: "Some.Release.Name",
    },
    { id: 503, date: "2026-08-12T10:00:00.000Z", eventType: "grabbed", series: { title: "Severance" } },
  ],
};

describe("normalizeServarrHistory", () => {
  it("maps import and failure events, ignoring grabbed/other noise", () => {
    const events = normalizeServarrHistory(SONARR_HISTORY_PAGE, "sonarr");
    expect(events.map((e) => e.kind).sort()).toEqual(["media.imported", "transfer.failed"]);
    const imported = events.find((e) => e.kind === "media.imported")!;
    expect(imported.title).toBe("Severance — S02E07");
    expect(imported.quality).toBe("WEB-DL 1080p");
    expect(imported.id).toBe("sonarr-history-501");
    const failed = events.find((e) => e.kind === "transfer.failed")!;
    expect(failed.title).toBe("Some.Release.Name"); // sourceTitle fallback
  });

  it("empty history → no events", () => {
    expect(normalizeServarrHistory({ records: [] }, "sonarr")).toEqual([]);
    expect(normalizeServarrHistory({}, "sonarr")).toEqual([]);
  });

  it("tolerates missing metadata (no series/movie/quality/date)", () => {
    const events = normalizeServarrHistory(
      { records: [
        { id: 1, date: "2026-08-12T10:00:00Z", eventType: "downloadFolderImported" }, // no title metadata
        { id: 2, eventType: "downloadFolderImported" }, // no date → skipped safely
      ] },
      "radarr",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("Unknown");
    expect(events[0]!.quality).toBeNull();
  });

  it("rejects malformed history payloads", () => {
    expect(() => normalizeServarrHistory({ records: "nope" }, "sonarr")).toThrow(
      ConnectorValidationError,
    );
  });
});

/** Fake paginated history http keyed on the `page=` query param. */
function pagedHttp(pages: Record<number, unknown>): { http: HttpGet; calls: () => number } {
  let calls = 0;
  const http: HttpGet = async (url) => {
    calls += 1;
    const m = url.match(/[?&]page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    if (!(page in pages)) throw new ConnectorError("sonarr.history returned HTTP 404");
    return pages[page];
  };
  return { http, calls: () => calls };
}

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const base = "http://sonarr:8989";
const headers = { "X-Api-Key": "k" };
const signal = new AbortController().signal;

describe("collectServarrHistory — pagination, window, dedup", () => {
  it("paginates until a short (last) page and returns within-window events", async () => {
    const { http, calls } = pagedHttp({
      1: { pageSize: 2, records: [
        { id: 10, date: "2026-08-12T11:59:00Z", eventType: "downloadFolderImported", series: { title: "A" } },
        { id: 9, date: "2026-08-12T11:58:00Z", eventType: "downloadFailed", sourceTitle: "b" },
      ] },
      2: { pageSize: 2, records: [
        { id: 8, date: "2026-08-12T11:57:00Z", eventType: "downloadFolderImported", series: { title: "C" } },
      ] },
    });
    const events = await collectServarrHistory({ http, base, headers, source: "sonarr", signal, now: NOW, pageSize: 2, lookbackMs: 6 * 3_600_000 });
    expect(calls()).toBe(2); // page 2 is short → stop
    expect(events.map((e) => e.id).sort()).toEqual(["sonarr-history-10", "sonarr-history-8", "sonarr-history-9"]);
    // Oldest-first ordering.
    expect(events[0]!.at).toBeLessThan(events[events.length - 1]!.at);
  });

  it("stops paginating once a page crosses the lookback window", async () => {
    const old = "2026-08-12T00:00:00Z"; // 12h ago, outside a 6h window
    const { http, calls } = pagedHttp({
      1: { pageSize: 2, records: [
        { id: 2, date: "2026-08-12T11:59:00Z", eventType: "downloadFolderImported", series: { title: "A" } },
        { id: 1, date: old, eventType: "downloadFolderImported", series: { title: "B" } },
      ] },
      2: { pageSize: 2, records: [{ id: 0, date: old, eventType: "downloadFolderImported" }] },
    });
    const events = await collectServarrHistory({ http, base, headers, source: "sonarr", signal, now: NOW, pageSize: 2, lookbackMs: 6 * 3_600_000, maxPages: 5 });
    expect(calls()).toBe(1); // page 1's oldest record already crossed the window
    expect(events.map((e) => e.id)).toEqual(["sonarr-history-2"]); // the 12h-old one excluded
  });

  it("dedupes a record that appears on overlapping pages", async () => {
    const rec = { id: 42, date: "2026-08-12T11:30:00Z", eventType: "downloadFolderImported", series: { title: "Dup" } };
    const { http } = pagedHttp({
      1: { pageSize: 2, records: [rec, { id: 41, date: "2026-08-12T11:29:00Z", eventType: "downloadFailed", sourceTitle: "x" }] },
      2: { pageSize: 2, records: [rec] }, // same record re-appears (a new import shifted the page)
    });
    const events = await collectServarrHistory({ http, base, headers, source: "sonarr", signal, now: NOW, pageSize: 2, maxPages: 3 });
    expect(events.filter((e) => e.id === "sonarr-history-42")).toHaveLength(1);
  });

  it("overlapping windows across polls yield stable ids (idempotent dedup)", async () => {
    const page = { pageSize: 50, records: [
      { id: 7, date: "2026-08-12T11:55:00Z", eventType: "downloadFolderImported", series: { title: "Z" } },
    ] };
    const { http } = pagedHttp({ 1: page });
    const first = await collectServarrHistory({ http, base, headers, source: "sonarr", signal, now: NOW });
    const second = await collectServarrHistory({ http, base, headers, source: "sonarr", signal, now: NOW + 60_000 });
    expect(first[0]!.id).toBe(second[0]!.id); // same id → INSERT OR IGNORE dedupes
  });

  it("propagates an http failure (caller decides degradation)", async () => {
    const http: HttpGet = async () => {
      throw new ConnectorError("sonarr.history returned HTTP 500");
    };
    await expect(
      collectServarrHistory({ http, base, headers, source: "sonarr", signal, now: NOW }),
    ).rejects.toThrow(ConnectorError);
  });
});

describe("connector factories", () => {
  it("Sonarr/Radarr poll queue + history, set their id, and return a ServarrSnapshot", async () => {
    const seen: string[] = [];
    const http: HttpGet = async (url) => {
      seen.push(url);
      return url.includes("/history") ? SONARR_HISTORY_PAGE : SONARR_QUEUE;
    };
    const sonarr = createSonarrConnector({ url: "http://sonarr:8989/", apiKey: "k", pollIntervalMs: 25_000 }, http, () => NOW);
    const radarr = createRadarrConnector({ url: "http://radarr:7878", apiKey: "k", pollIntervalMs: 25_000 }, http, () => NOW);
    expect(sonarr.id).toBe("sonarr");
    expect(radarr.id).toBe("radarr");
    const snap = await sonarr.poll(signal);
    expect(seen.some((u) => u.includes("http://sonarr:8989/api/v3/queue"))).toBe(true);
    expect(seen.some((u) => u.includes("http://sonarr:8989/api/v3/history"))).toBe(true);
    expect(snap.items).toHaveLength(2);
    expect(snap.events.length).toBeGreaterThan(0);
  });

  it("keeps queue items when the history path fails (best-effort history)", async () => {
    const http: HttpGet = async (url) => {
      if (url.includes("/history")) throw new ConnectorError("sonarr.history returned HTTP 500");
      return SONARR_QUEUE;
    };
    const sonarr = createSonarrConnector({ url: "http://sonarr:8989", apiKey: "k", pollIntervalMs: 25_000 }, http, () => NOW);
    const snap = await sonarr.poll(signal);
    expect(snap.items).toHaveLength(2); // queue still functional
    expect(snap.events).toEqual([]); // history degraded gracefully
  });
});
