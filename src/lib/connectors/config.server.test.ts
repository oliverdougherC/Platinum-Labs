import { describe, expect, it } from "vitest";
import { resolveConnectors } from "@/lib/connectors/config.server";
import type { ServerEnv } from "@/lib/env.server";

/** Build a fully-defaulted ServerEnv with the given overrides. */
function env(overrides: Partial<ServerEnv>): ServerEnv {
  return {
    HOMELAB_DATA_MODE: "live",
    JELLYFIN_URL: undefined,
    JELLYFIN_API_KEY: undefined,
    SONARR_URL: undefined,
    SONARR_API_KEY: undefined,
    RADARR_URL: undefined,
    RADARR_API_KEY: undefined,
    QBITTORRENT_URL: undefined,
    QBITTORRENT_USERNAME: undefined,
    QBITTORRENT_PASSWORD: undefined,
    ZFS_COLLECTOR_URL: undefined,
    ZFS_COLLECTOR_TOKEN: undefined,
    HOMELAB_ZFS_COMMAND: false,
    HOMELAB_DB_PATH: "./data/homelab.db",
    HOMELAB_FAKE_SCENARIO: undefined,
    HOMELAB_ENABLE_DEV_CONTROLS: false,
    HOMELAB_QUICK_LINKS: undefined,
    ...overrides,
  };
}

describe("resolveConnectors — http services", () => {
  it("absent when no fields are set", () => {
    expect(resolveConnectors(env({})).jellyfin).toEqual({ kind: "absent" });
  });

  it("configured when url + key are both present", () => {
    const r = resolveConnectors(
      env({ JELLYFIN_URL: "http://jf:8096", JELLYFIN_API_KEY: "abc" }),
    ).jellyfin;
    expect(r.kind).toBe("configured");
    if (r.kind === "configured") {
      expect(r.value).toEqual({ url: "http://jf:8096", apiKey: "abc" });
    }
  });

  it("partial (misconfigured) when url is set without the key", () => {
    const r = resolveConnectors(env({ SONARR_URL: "http://s:8989" })).sonarr;
    expect(r.kind).toBe("partial");
    if (r.kind === "partial") {
      expect(r.error).toContain("SONARR_API_KEY");
      // Never leaks the value that *was* provided.
      expect(r.error).not.toContain("8989");
    }
  });

  it("partial when only the key is set (no url)", () => {
    const r = resolveConnectors(env({ RADARR_API_KEY: "secret-key-value" })).radarr;
    expect(r.kind).toBe("partial");
    if (r.kind === "partial") {
      expect(r.error).toContain("RADARR_URL");
      expect(r.error).not.toContain("secret-key-value");
    }
  });
});

describe("resolveConnectors — qbittorrent (three fields)", () => {
  it("configured with url + username + password", () => {
    const r = resolveConnectors(
      env({
        QBITTORRENT_URL: "http://qb:8080",
        QBITTORRENT_USERNAME: "admin",
        QBITTORRENT_PASSWORD: "pw",
      }),
    ).qbittorrent;
    expect(r.kind).toBe("configured");
  });

  it("partial when the password is missing", () => {
    const r = resolveConnectors(
      env({ QBITTORRENT_URL: "http://qb:8080", QBITTORRENT_USERNAME: "admin" }),
    ).qbittorrent;
    expect(r.kind).toBe("partial");
    if (r.kind === "partial") expect(r.error).toContain("QBITTORRENT_PASSWORD");
  });
});

describe("resolveConnectors — zfs (two modes)", () => {
  it("absent with nothing set", () => {
    expect(resolveConnectors(env({})).zfs).toEqual({ kind: "absent" });
  });

  it("helper mode when the collector url is set", () => {
    const r = resolveConnectors(
      env({ ZFS_COLLECTOR_URL: "http://host:9000", ZFS_COLLECTOR_TOKEN: "t" }),
    ).zfs;
    expect(r.kind).toBe("configured");
    if (r.kind === "configured") expect(r.value).toEqual({ mode: "helper", url: "http://host:9000", token: "t" });
  });

  it("command mode when explicitly opted in", () => {
    const r = resolveConnectors(env({ HOMELAB_ZFS_COMMAND: true })).zfs;
    expect(r.kind).toBe("configured");
    if (r.kind === "configured") expect(r.value).toEqual({ mode: "command" });
  });

  it("partial when a token is set with no url and no command mode", () => {
    const r = resolveConnectors(env({ ZFS_COLLECTOR_TOKEN: "orphan-token" })).zfs;
    expect(r.kind).toBe("partial");
    if (r.kind === "partial") expect(r.error).not.toContain("orphan-token");
  });
});
