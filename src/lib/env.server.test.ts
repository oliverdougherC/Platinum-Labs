import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getServerEnv, resetServerEnvCache } from "@/lib/env.server";

/**
 * Environment parsing regression tests (V2.1 review blocker): a template
 * `.env` ships every key blank (`FOO=`), so blank values must parse exactly
 * like absent ones — while malformed non-blank values still fail loudly.
 */

const MANAGED_KEYS = [
  "HOMELAB_DATA_MODE",
  "HOMELAB_NETWORK_LINK_MBPS",
  "HOMELAB_HOST_LABEL",
  "HOMELAB_DB_PATH",
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  resetServerEnvCache();
});

describe("HOMELAB_NETWORK_LINK_MBPS parsing", () => {
  it("is undefined when the variable is absent", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: undefined });
    expect(getServerEnv().HOMELAB_NETWORK_LINK_MBPS).toBeUndefined();
  });

  it("treats an empty string like an absent variable (env-template case)", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "" });
    expect(getServerEnv().HOMELAB_NETWORK_LINK_MBPS).toBeUndefined();
  });

  it("treats whitespace-only input like an absent variable", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "   " });
    expect(getServerEnv().HOMELAB_NETWORK_LINK_MBPS).toBeUndefined();
  });

  it("accepts a valid 1 GbE value", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "1000" });
    expect(getServerEnv().HOMELAB_NETWORK_LINK_MBPS).toBe(1000);
  });

  it("accepts a valid 10 GbE value", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "10000" });
    expect(getServerEnv().HOMELAB_NETWORK_LINK_MBPS).toBe(10000);
  });

  it("rejects a value below the 100 Mbps minimum", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "10" });
    expect(() => getServerEnv()).toThrow(/HOMELAB_NETWORK_LINK_MBPS/);
  });

  it("rejects malformed non-blank text — validation is not weakened", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "fast" });
    expect(() => getServerEnv()).toThrow(/HOMELAB_NETWORK_LINK_MBPS/);
  });

  it("rejects a non-integer value", () => {
    setEnv({ HOMELAB_NETWORK_LINK_MBPS: "1000.5" });
    expect(() => getServerEnv()).toThrow(/HOMELAB_NETWORK_LINK_MBPS/);
  });
});

describe(".env.example regression", () => {
  /** Parse the committed template exactly as dotenv/compose would. */
  function exampleEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env.example", "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return out;
  }

  it("the exact values shipped in .env.example parse cleanly", () => {
    const example = exampleEnv();
    // The template must actually exercise the blank-numeric case this file
    // regresses — if the key is dropped from the template, fail here rather
    // than silently losing coverage.
    expect(example).toHaveProperty("HOMELAB_NETWORK_LINK_MBPS", "");

    for (const key of Object.keys(example)) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
    }
    for (const key of MANAGED_KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      delete process.env[key];
    }
    Object.assign(process.env, example);
    resetServerEnvCache();

    const env = getServerEnv();
    expect(env.HOMELAB_DATA_MODE).toBe("fake");
    expect(env.HOMELAB_NETWORK_LINK_MBPS).toBeUndefined();
    expect(env.HOMELAB_HOST_LABEL).toBeUndefined();
    expect(env.JELLYFIN_URL).toBeUndefined();
  });
});
