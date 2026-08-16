/**
 * Compose network isolation (PLA-265 review blocker) — the deployed topology
 * is a security boundary, so it is asserted, not merely described in comments.
 *
 * Invariants:
 *  - homepage ↔ zfs-collector share `zfs_private` (telemetry polling works);
 *  - zfs-collector ↔ docker-proxy share `docker_telemetry_private` ONLY;
 *  - homepage is NOT attached to `docker_telemetry_private` — the dashboard
 *    container must have no route to the Docker socket proxy;
 *  - docker-proxy is attached to NOTHING except `docker_telemetry_private`
 *    (in particular, never to `zfs_private`, where homepage lives);
 *  - both private networks are `internal` (no egress);
 *  - the proxy stays read-only and minimum-scope (GET-only, containers only,
 *    socket mounted `:ro`).
 *
 * The test parses the same file pair `npm run compose:prod:config` composes,
 * applying Compose's mapping-merge semantics for the keys it asserts on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type ComposeDoc = {
  services?: Record<
    string,
    {
      networks?: Record<string, unknown> | string[];
      environment?: Record<string, unknown>;
      volumes?: unknown[];
    }
  >;
  networks?: Record<string, { internal?: boolean } | null>;
};

function load(name: string): ComposeDoc {
  return parse(readFileSync(join(process.cwd(), name), "utf8")) as ComposeDoc;
}

/** Service networks across the base + production pair (mapping-merge union). */
function networksOf(docs: ComposeDoc[], service: string): Set<string> {
  const out = new Set<string>();
  for (const doc of docs) {
    const nets = doc.services?.[service]?.networks;
    if (!nets) continue;
    for (const name of Array.isArray(nets) ? nets : Object.keys(nets)) {
      out.add(name);
    }
  }
  // A service with no networks key anywhere joins the implicit default.
  if (out.size === 0) out.add("default");
  return out;
}

describe("production compose topology isolation", () => {
  const docs = [load("docker-compose.yml"), load("docker-compose.production.yml")];
  const production = docs[1]!;

  it("homepage and the collector share zfs_private (polling path)", () => {
    expect(networksOf(docs, "homepage")).toContain("zfs_private");
    expect(networksOf(docs, "zfs-collector")).toContain("zfs_private");
  });

  it("collector and docker-proxy share docker_telemetry_private", () => {
    expect(networksOf(docs, "zfs-collector")).toContain("docker_telemetry_private");
    expect(networksOf(docs, "docker-proxy")).toContain("docker_telemetry_private");
  });

  it("homepage can never reach the docker socket proxy", () => {
    const homepage = networksOf(docs, "homepage");
    const proxy = networksOf(docs, "docker-proxy");
    // No shared network between homepage and docker-proxy, under any merge.
    const shared = [...homepage].filter((n) => proxy.has(n));
    expect(shared).toEqual([]);
    expect(homepage.has("docker_telemetry_private")).toBe(false);
  });

  it("docker-proxy joins ONLY the collector-only telemetry network", () => {
    expect([...networksOf(docs, "docker-proxy")]).toEqual([
      "docker_telemetry_private",
    ]);
  });

  it("both private networks are internal (no egress)", () => {
    expect(production.networks?.zfs_private?.internal).toBe(true);
    expect(production.networks?.docker_telemetry_private?.internal).toBe(true);
  });

  it("the docker proxy stays read-only and minimum-scope", () => {
    const proxy = production.services?.["docker-proxy"];
    expect(proxy?.environment?.CONTAINERS).toBe(1);
    expect(proxy?.environment?.POST).toBe(0);
    // Exactly the socket, mounted read-only; no other mounts.
    expect(proxy?.volumes).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock:ro",
    ]);
  });
});
