import { afterEach, describe, expect, it, vi } from "vitest";
import { resetServerEnvCache, getServerEnv } from "@/lib/env.server";
import { getSeerrAvailability, resolveSeerr } from "@/lib/seerr/config.server";
import type { ServerEnv } from "@/lib/env.server";

function env(overrides: Partial<ServerEnv>): ServerEnv {
  // Parse a minimal real env, then apply typed overrides.
  vi.stubEnv("HOMELAB_DATA_MODE", "live");
  resetServerEnvCache();
  const base = getServerEnv();
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
});

describe("resolveSeerr", () => {
  it("is absent when nothing is configured", () => {
    expect(resolveSeerr(env({}))).toEqual({ kind: "absent" });
  });

  it("is configured from SEERR_URL + SEERR_API_KEY", () => {
    const r = resolveSeerr(
      env({ SEERR_URL: "http://seerr:5055", SEERR_API_KEY: "k", SEERR_REQUESTS_ENABLED: true }),
    );
    expect(r).toEqual({
      kind: "configured",
      value: { url: "http://seerr:5055", apiKey: "k", requestsEnabled: true },
    });
  });

  it("accepts legacy JELLYSEERR_* aliases", () => {
    const r = resolveSeerr(
      env({ JELLYSEERR_URL: "http://jellyseerr:5055", JELLYSEERR_API_KEY: "legacy" }),
    );
    expect(r).toMatchObject({
      kind: "configured",
      value: { url: "http://jellyseerr:5055", apiKey: "legacy" },
    });
  });

  it("prefers SEERR_* over the legacy aliases when both are set", () => {
    const r = resolveSeerr(
      env({
        SEERR_URL: "http://seerr:5055",
        SEERR_API_KEY: "new",
        JELLYSEERR_URL: "http://jellyseerr:5055",
        JELLYSEERR_API_KEY: "legacy",
      }),
    );
    expect(r).toMatchObject({
      kind: "configured",
      value: { url: "http://seerr:5055", apiKey: "new" },
    });
  });

  it("reports a half-configured integration without echoing secrets", () => {
    const r = resolveSeerr(env({ SEERR_API_KEY: "secret-value" }));
    expect(r.kind).toBe("partial");
    if (r.kind === "partial") {
      expect(r.error).toContain("SEERR_URL");
      expect(r.error).not.toContain("secret-value");
    }
  });

  it("carries the requests-enabled flag", () => {
    const r = resolveSeerr(
      env({
        SEERR_URL: "http://seerr:5055",
        SEERR_API_KEY: "k",
        SEERR_REQUESTS_ENABLED: false,
      }),
    );
    expect(r).toMatchObject({ value: { requestsEnabled: false } });
  });
});

describe("getSeerrAvailability", () => {
  it("enables both capabilities in fake mode with no configuration", () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "fake");
    resetServerEnvCache();
    expect(getSeerrAvailability()).toEqual({ search: true, requests: true });
  });

  it("disables everything in live mode when unconfigured", () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    resetServerEnvCache();
    expect(getSeerrAvailability()).toEqual({ search: false, requests: false });
  });

  it("keeps search on while requests are disabled via the flag", () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    vi.stubEnv("SEERR_URL", "http://seerr:5055");
    vi.stubEnv("SEERR_API_KEY", "k");
    vi.stubEnv("SEERR_REQUESTS_ENABLED", "0");
    resetServerEnvCache();
    expect(getSeerrAvailability()).toEqual({ search: true, requests: false });
  });

  it("defaults requests to enabled when configured", () => {
    vi.stubEnv("HOMELAB_DATA_MODE", "live");
    vi.stubEnv("SEERR_URL", "http://seerr:5055");
    vi.stubEnv("SEERR_API_KEY", "k");
    resetServerEnvCache();
    expect(getSeerrAvailability()).toEqual({ search: true, requests: true });
  });
});
