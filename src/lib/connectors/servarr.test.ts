import { describe, expect, it } from "vitest";
import {
  createRadarrConnector,
  createSonarrConnector,
  mapServarrState,
  normalizeServarrQueue,
  parseTimeleft,
} from "@/lib/connectors/servarr";
import { ConnectorValidationError } from "@/lib/connectors/connector";
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

describe("connector factories", () => {
  it("Sonarr/Radarr call /api/v3/queue and set their id", async () => {
    const seen: string[] = [];
    const http: HttpGet = async (url) => {
      seen.push(url);
      return SONARR_QUEUE;
    };
    const sonarr = createSonarrConnector({ url: "http://sonarr:8989/", apiKey: "k", pollIntervalMs: 25_000 }, http);
    const radarr = createRadarrConnector({ url: "http://radarr:7878", apiKey: "k", pollIntervalMs: 25_000 }, http);
    expect(sonarr.id).toBe("sonarr");
    expect(radarr.id).toBe("radarr");
    await sonarr.poll(new AbortController().signal);
    expect(seen[0]).toContain("http://sonarr:8989/api/v3/queue");
  });
});
