import { describe, expect, it } from "vitest";
import {
  createJellyfinConnector,
  normalizeJellyfin,
  resolutionFromHeight,
  type HttpGet,
} from "@/lib/connectors/jellyfin";
import { ConnectorValidationError } from "@/lib/connectors/connector";

const NOW = 1_754_000_000_000;

const SYSTEM = { Version: "10.9.11", ServerName: "homelab" };

const MOVIE_SESSION = {
  Id: "s1",
  UserName: "oliver",
  NowPlayingItem: { Name: "Dune: Part Two", RunTimeTicks: 1000, Height: 2160, Type: "Movie" },
  PlayState: { PositionTicks: 420, PlayMethod: "DirectPlay" },
};

const EPISODE_TRANSCODE = {
  Id: "s2",
  UserName: "sam",
  NowPlayingItem: {
    Name: "Tomorrow",
    SeriesName: "The Bear",
    ParentIndexNumber: 3,
    IndexNumber: 1,
    RunTimeTicks: 1000,
    Height: 1080,
  },
  PlayState: { PositionTicks: 270, PlayMethod: "Transcode" },
  TranscodingInfo: { Bitrate: 12_000_000 },
};

describe("resolutionFromHeight", () => {
  it("maps common heights", () => {
    expect(resolutionFromHeight(2160)).toBe("4K");
    expect(resolutionFromHeight(1080)).toBe("1080p");
    expect(resolutionFromHeight(720)).toBe("720p");
    expect(resolutionFromHeight(480)).toBe("480p");
    expect(resolutionFromHeight(undefined)).toBeNull();
  });
});

describe("normalizeJellyfin", () => {
  it("normalizes a direct-play movie session", () => {
    const snap = normalizeJellyfin({ system: SYSTEM, sessions: [MOVIE_SESSION] }, NOW);
    expect(snap.serverAvailable).toBe(true);
    expect(snap.version).toBe("10.9.11");
    expect(snap.sessions).toHaveLength(1);
    const s = snap.sessions[0]!;
    expect(s.title).toBe("Dune: Part Two");
    expect(s.subtitle).toBeNull();
    expect(s.method).toBe("direct-play");
    expect(s.progress).toBeCloseTo(0.42, 5);
    expect(s.resolution).toBe("4K");
    expect(snap.lastPlaybackAt).toBe(NOW);
  });

  it("normalizes an episode transcode with SxxEyy subtitle and bitrate", () => {
    const snap = normalizeJellyfin({ system: SYSTEM, sessions: [EPISODE_TRANSCODE] }, NOW);
    const s = snap.sessions[0]!;
    expect(s.title).toBe("The Bear");
    expect(s.subtitle).toBe("S03E01 — Tomorrow");
    expect(s.method).toBe("transcode");
    expect(s.bitrateBps).toBe(12_000_000);
    expect(s.resolution).toBe("1080p");
  });

  it("ignores sessions with nothing playing", () => {
    const idle = { Id: "s3", UserName: "x" }; // no NowPlayingItem
    const snap = normalizeJellyfin({ system: SYSTEM, sessions: [idle] }, NOW);
    expect(snap.sessions).toHaveLength(0);
    expect(snap.lastPlaybackAt).toBeNull();
  });

  it("rejects malformed upstream data", () => {
    expect(() =>
      normalizeJellyfin({ system: SYSTEM, sessions: "not-an-array" }, NOW),
    ).toThrow(ConnectorValidationError);
  });
});

describe("createJellyfinConnector", () => {
  it("polls System/Info and Sessions and normalizes", async () => {
    const calls: string[] = [];
    const http: HttpGet = async (url) => {
      calls.push(url);
      return url.endsWith("/System/Info") ? SYSTEM : [MOVIE_SESSION];
    };
    const connector = createJellyfinConnector(
      { url: "http://jelly:8096/", apiKey: "secret", pollIntervalMs: 12_000 },
      http,
      () => NOW,
    );
    const snap = await connector.poll(new AbortController().signal);
    expect(connector.id).toBe("jellyfin");
    expect(calls).toContain("http://jelly:8096/System/Info");
    expect(calls).toContain("http://jelly:8096/Sessions");
    expect(snap.sessions).toHaveLength(1);
  });
});
