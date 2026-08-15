import { describe, expect, it } from "vitest";
import { ConnectorValidationError } from "@/lib/connectors/connector";
import {
  isValidPosterPath,
  mapMediaStatus,
  MEDIA_STATUS,
  missingSeasonNumbers,
  normalizePosterPath,
  normalizeSearch,
  posterProxyUrl,
  seerrTvDetailsSchema,
} from "@/lib/seerr/api";

function searchPage(results: unknown[]): unknown {
  return { page: 1, totalPages: 1, results };
}

const movie = {
  id: 693134,
  mediaType: "movie",
  title: "Dune: Part Two",
  releaseDate: "2024-02-27",
  posterPath: "/abc123.jpg",
  overview: "Paul Atreides unites with the Fremen.",
};

const tv = {
  id: 95396,
  mediaType: "tv",
  name: "Severance",
  firstAirDate: "2022-02-17",
  posterPath: "/def456.jpg",
  overview: "Work-life balance, surgically enforced.",
  mediaInfo: { status: MEDIA_STATUS.PROCESSING },
};

const person = {
  id: 17419,
  mediaType: "person",
  name: "Adam Scott",
};

describe("normalizeSearch", () => {
  it("normalizes a movie result to the UI-safe shape", () => {
    const [r] = normalizeSearch(searchPage([movie]));
    expect(r).toEqual({
      id: 693134,
      mediaType: "movie",
      title: "Dune: Part Two",
      year: 2024,
      posterPath: "/abc123.jpg",
      overview: "Paul Atreides unites with the Fremen.",
      state: "requestable",
    });
  });

  it("normalizes a TV result using name/firstAirDate and mediaInfo state", () => {
    const [r] = normalizeSearch(searchPage([tv]));
    expect(r).toMatchObject({
      mediaType: "tv",
      title: "Severance",
      year: 2022,
      state: "processing",
    });
  });

  it("normalizes DELETED media as requestable and BLOCKLISTED as blocklisted", () => {
    const [deleted, blocklisted] = normalizeSearch(
      searchPage([
        { ...movie, mediaInfo: { status: MEDIA_STATUS.DELETED } },
        { ...tv, mediaInfo: { status: MEDIA_STATUS.BLOCKLISTED } },
      ]),
    );
    expect(deleted!.state).toBe("requestable");
    expect(blocklisted!.state).toBe("blocklisted");
  });

  it("drops person results entirely", () => {
    const results = normalizeSearch(searchPage([person, movie]));
    expect(results).toHaveLength(1);
    expect(results[0]!.mediaType).toBe("movie");
  });

  it("tolerates missing optional fields", () => {
    const [r] = normalizeSearch(
      searchPage([{ id: 1, mediaType: "movie", title: "Untitled" }]),
    );
    expect(r).toMatchObject({ year: null, posterPath: null, overview: null });
  });

  it("drops results with no usable title", () => {
    expect(
      normalizeSearch(searchPage([{ id: 1, mediaType: "movie", title: "  " }])),
    ).toEqual([]);
  });

  it("truncates long overviews", () => {
    const [r] = normalizeSearch(
      searchPage([{ ...movie, overview: "x".repeat(500) }]),
    );
    expect(r!.overview!.length).toBeLessThanOrEqual(240);
    expect(r!.overview!.endsWith("…")).toBe(true);
  });

  it("rejects unexpected poster paths so the proxy cannot be steered", () => {
    const [r] = normalizeSearch(
      searchPage([{ ...movie, posterPath: "https://evil.example/x.jpg" }]),
    );
    expect(r!.posterPath).toBeNull();
  });

  it("throws a sanitized validation error on malformed payloads", () => {
    expect(() => normalizeSearch({ nope: true })).toThrow(ConnectorValidationError);
    expect(() => normalizeSearch(searchPage([{ mediaType: "movie" }]))).toThrow(
      ConnectorValidationError,
    );
  });
});

describe("mapMediaStatus", () => {
  it("maps every documented status to a stable dashboard state", () => {
    expect(mapMediaStatus(undefined)).toBe("requestable");
    expect(mapMediaStatus(MEDIA_STATUS.UNKNOWN)).toBe("requestable");
    expect(mapMediaStatus(MEDIA_STATUS.PENDING)).toBe("pending");
    expect(mapMediaStatus(MEDIA_STATUS.PROCESSING)).toBe("processing");
    expect(mapMediaStatus(MEDIA_STATUS.PARTIALLY_AVAILABLE)).toBe("partial");
    expect(mapMediaStatus(MEDIA_STATUS.AVAILABLE)).toBe("available");
    expect(mapMediaStatus(MEDIA_STATUS.BLOCKLISTED)).toBe("blocklisted");
    expect(mapMediaStatus(MEDIA_STATUS.DELETED)).toBe("requestable");
  });

  it("REGRESSION: DELETED media is requestable again, BLOCKLISTED is not", () => {
    expect(mapMediaStatus(MEDIA_STATUS.DELETED)).toBe("requestable");
    expect(mapMediaStatus(MEDIA_STATUS.BLOCKLISTED)).not.toBe("requestable");
  });

  it("maps unrecognized future statuses to a non-requestable state", () => {
    expect(mapMediaStatus(8)).toBe("processing");
    expect(mapMediaStatus(99)).toBe("processing");
  });
});

describe("missingSeasonNumbers", () => {
  const details = (seasons: unknown[], mediaInfoSeasons?: unknown[]) =>
    seerrTvDetailsSchema.parse({
      id: 1,
      name: "Show",
      seasons,
      mediaInfo: mediaInfoSeasons ? { status: 4, seasons: mediaInfoSeasons } : undefined,
    });

  it("returns all real seasons when Seerr tracks nothing", () => {
    expect(
      missingSeasonNumbers(
        details([
          { seasonNumber: 0, episodeCount: 3 },
          { seasonNumber: 1, episodeCount: 10 },
          { seasonNumber: 2, episodeCount: 8 },
        ]),
      ),
    ).toEqual([1, 2]);
  });

  it("excludes seasons Seerr already tracks (any non-UNKNOWN status)", () => {
    expect(
      missingSeasonNumbers(
        details(
          [
            { seasonNumber: 1, episodeCount: 10 },
            { seasonNumber: 2, episodeCount: 8 },
            { seasonNumber: 3, episodeCount: 8 },
          ],
          [
            { seasonNumber: 1, status: MEDIA_STATUS.AVAILABLE },
            { seasonNumber: 2, status: MEDIA_STATUS.PENDING },
            { seasonNumber: 3, status: MEDIA_STATUS.UNKNOWN },
          ],
        ),
      ),
    ).toEqual([3]);
  });

  it("counts DELETED seasons as missing but never BLOCKLISTED or unknown future statuses", () => {
    expect(
      missingSeasonNumbers(
        details(
          [
            { seasonNumber: 1, episodeCount: 10 },
            { seasonNumber: 2, episodeCount: 8 },
            { seasonNumber: 3, episodeCount: 8 },
            { seasonNumber: 4, episodeCount: 8 },
          ],
          [
            { seasonNumber: 1, status: MEDIA_STATUS.DELETED },
            { seasonNumber: 2, status: MEDIA_STATUS.BLOCKLISTED },
            { seasonNumber: 3, status: 99 },
          ],
        ),
      ),
    ).toEqual([1, 4]);
  });

  it("excludes specials and empty placeholder seasons", () => {
    expect(
      missingSeasonNumbers(
        details([
          { seasonNumber: 0, episodeCount: 5 },
          { seasonNumber: 1, episodeCount: 0 },
          { seasonNumber: 2 },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("poster helpers", () => {
  it("accepts only TMDB-shaped poster paths", () => {
    expect(isValidPosterPath("/abc123.jpg")).toBe(true);
    expect(isValidPosterPath("/aB9.png")).toBe(true);
    expect(isValidPosterPath("abc.jpg")).toBe(false);
    expect(isValidPosterPath("/a/b.jpg")).toBe(false);
    expect(isValidPosterPath("/abc.svg")).toBe(false);
    expect(isValidPosterPath("/abc.jpg?x=1")).toBe(false);
    expect(isValidPosterPath("https://evil.example/a.jpg")).toBe(false);
  });

  it("normalizes unexpected upstream paths to null", () => {
    expect(normalizePosterPath("/ok1.jpg")).toBe("/ok1.jpg");
    expect(normalizePosterPath("//evil.example/a.jpg")).toBeNull();
    expect(normalizePosterPath(null)).toBeNull();
  });

  it("builds same-origin proxy URLs", () => {
    expect(posterProxyUrl("/abc123.jpg", "w92")).toBe(
      "/api/seerr/poster?size=w92&path=%2Fabc123.jpg",
    );
  });
});
