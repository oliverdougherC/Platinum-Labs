import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  getFabricRelationships,
  getServerEnv,
  resetServerEnvCache,
} from "@/lib/env.server";

/**
 * Environment parsing regression tests (V2.1 review blocker): a template
 * `.env` ships every key blank (`FOO=`), so blank values must parse exactly
 * like absent ones — while malformed non-blank values still fail loudly.
 */

const MANAGED_KEYS = [
  "HOMELAB_DATA_MODE",
  "HOMELAB_UI_MODE",
  "HOMELAB_FABRIC_RELATIONSHIPS",
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
    expect(env.HOMELAB_UI_MODE).toBe("topology");
    expect(env.HOMELAB_NETWORK_LINK_MBPS).toBeUndefined();
    expect(env.HOMELAB_HOST_LABEL).toBeUndefined();
    expect(env.JELLYFIN_URL).toBeUndefined();
  });
});

describe("HOMELAB_UI_MODE parsing", () => {
  it("defaults to topology when unset", () => {
    setEnv({ HOMELAB_UI_MODE: undefined });
    expect(getServerEnv().HOMELAB_UI_MODE).toBe("topology");
  });

  it("accepts the fabric seam flag", () => {
    setEnv({ HOMELAB_UI_MODE: "fabric" });
    expect(getServerEnv().HOMELAB_UI_MODE).toBe("fabric");
  });

  it("rejects unknown UI modes", () => {
    setEnv({ HOMELAB_UI_MODE: "v4" });
    expect(() => getServerEnv()).toThrow(/HOMELAB_UI_MODE/);
  });
});

describe("HOMELAB_FABRIC_RELATIONSHIPS parsing", () => {
  it("treats the variable as optional", () => {
    setEnv({ HOMELAB_FABRIC_RELATIONSHIPS: undefined });
    expect(getServerEnv().HOMELAB_FABRIC_RELATIONSHIPS).toBeUndefined();
    expect(getFabricRelationships()).toEqual([]);
  });

  it("accepts a bounded relationship list", () => {
    setEnv({
      HOMELAB_FABRIC_RELATIONSHIPS: JSON.stringify([
        {
          from: "host:control",
          to: "service:jellyfin",
          kind: "control",
          label: "manages",
        },
        {
          from: "service:seerr",
          to: "service:radarr",
          kind: "dependency",
        },
      ]),
    });

    const expected = [
      {
        from: "host:control",
        to: "service:jellyfin",
        kind: "control",
        label: "manages",
      },
      {
        from: "service:seerr",
        to: "service:radarr",
        kind: "dependency",
      },
    ];

    expect(getServerEnv().HOMELAB_FABRIC_RELATIONSHIPS).toEqual(expected);
    expect(getFabricRelationships()).toEqual(expected);
  });

  it("rejects malformed JSON", () => {
    setEnv({ HOMELAB_FABRIC_RELATIONSHIPS: "{bad json" });
    expect(() => getServerEnv()).toThrow(/HOMELAB_FABRIC_RELATIONSHIPS/);
  });

  it("rejects unsafe identifiers and arbitrary payload", () => {
    setEnv({
      HOMELAB_FABRIC_RELATIONSHIPS: JSON.stringify([
        {
          from: "../host",
          to: "service:jellyfin",
          kind: "control",
          extra: "nope",
        },
      ]),
    });
    expect(() => getServerEnv()).toThrow(/HOMELAB_FABRIC_RELATIONSHIPS/);
  });

  it("rejects unknown relationship fields even when identifiers are safe", () => {
    setEnv({
      HOMELAB_FABRIC_RELATIONSHIPS: JSON.stringify([
        {
          from: "service:sonarr",
          to: "service:jellyfin",
          kind: "control",
          payload: "not allowed",
        },
      ]),
    });
    expect(() => getServerEnv()).toThrow(/HOMELAB_FABRIC_RELATIONSHIPS/);
  });
});
