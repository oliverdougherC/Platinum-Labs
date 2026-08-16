#!/usr/bin/env node
/**
 * Startup smoke check against the COMMITTED example environment (V2.1 review
 * blocker). `docker compose config` only proves the topology parses; this
 * proves the app actually boots and serves with `.env.example` values —
 * catching template/validation drift like a blank numeric var failing Zod
 * coercion while /api/health still answers 200 with `mode: unknown`.
 *
 * USAGE
 *   node scripts/smoke-example-env.mjs [--skip-build]
 *
 * Runs `next build` (unless --skip-build), then `next start` with every
 * `.env.example` key injected verbatim (blank values included — that is the
 * point). Explicit injection also shields the check from any local
 * `.env.local`, because Next.js never overrides already-set process env.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3917;
const SKIP_BUILD = process.argv.includes("--skip-build");

function parseExampleEnv() {
  const out = {};
  for (const line of readFileSync(".env.example", "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const exampleEnv = {
  ...parseExampleEnv(),
  // Keep the smoke run hermetic: never touch the working copy's dev database.
  HOMELAB_DB_PATH: join(mkdtempSync(join(tmpdir(), "homelab-smoke-")), "homelab.db"),
};

async function waitFor(url, timeoutMs = 30_000) {
  const start = Date.now();
  let lastError = "no response";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${url} did not become ready: ${lastError}`);
}

async function main() {
  if (!SKIP_BUILD) {
    console.log("building production bundle for the smoke check…");
    const build = spawnSync("npx", ["next", "build"], {
      env: { ...process.env, ...exampleEnv },
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("next build failed under .env.example");
  }

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env: { ...process.env, ...exampleEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  try {
    const health = await (await waitFor(`http://localhost:${PORT}/api/health`)).json();
    if (health.status !== "ok") {
      throw new Error(`health status is ${JSON.stringify(health.status)}`);
    }
    // `mode: unknown` means getServerEnv() threw — the exact regression this
    // smoke exists to catch. The example env must resolve a REAL mode.
    if (health.mode !== "fake") {
      throw new Error(
        `health mode is ${JSON.stringify(health.mode)} — the example environment failed validation`,
      );
    }

    const home = await fetch(`http://localhost:${PORT}/`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!home.ok) throw new Error(`GET / returned HTTP ${home.status}`);
    const html = await home.text();
    if (!html.includes("data-app-shell")) {
      throw new Error("GET / did not render the app shell");
    }
    if (/Invalid environment configuration/i.test(html)) {
      throw new Error("GET / rendered an environment configuration error");
    }
    console.log("smoke ok: .env.example boots cleanly (health ok/fake, homepage renders)");
  } catch (err) {
    console.error("--- server output ---\n" + serverLog);
    throw err;
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
