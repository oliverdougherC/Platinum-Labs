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
 *
 * The Next CLI is spawned DIRECTLY (resolved bin, not `npx`) so the server is
 * our immediate child: `npx` on Linux can leave the real server as a grandchild
 * holding the inherited stdio pipes, which keeps this process alive forever
 * after `server.kill()` only terminates the wrapper. Teardown is bounded
 * (SIGTERM → SIGKILL) and a final self-check proves the child is gone before
 * the script resolves.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const PORT = 3917;
const SKIP_BUILD = process.argv.includes("--skip-build");
/** Grace period between SIGTERM and SIGKILL during teardown. */
const SHUTDOWN_GRACE_MS = 4_000;

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

// Keep the smoke run hermetic: never touch the working copy's dev database.
const tempDbDir = mkdtempSync(join(tmpdir(), "homelab-smoke-"));
const exampleEnv = {
  ...parseExampleEnv(),
  HOMELAB_DB_PATH: join(tempDbDir, "homelab.db"),
};

/** Records the child's exit as it happens so every wait loop can observe it. */
function trackExit(child) {
  const state = { exited: false, code: null, signal: null };
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });
  return state;
}

async function waitFor(url, exitState, timeoutMs = 30_000) {
  const start = Date.now();
  let lastError = "no response";
  while (Date.now() - start < timeoutMs) {
    if (exitState.exited) {
      throw new Error(
        `server exited before becoming ready (code=${exitState.code}, signal=${exitState.signal})`,
      );
    }
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

/**
 * Bounded teardown: no-op if the child already exited; otherwise SIGTERM,
 * escalate to SIGKILL after SHUTDOWN_GRACE_MS, and never leave a live timer
 * or listener behind. SIGKILL cannot be ignored, so the exit event is
 * guaranteed; a final unref'd give-up path exists purely so cleanup itself
 * can never hang the runner.
 */
async function stopServer(child, exitState) {
  if (exitState.exited) return;
  await new Promise((resolve) => {
    let killTimer;
    let giveUpTimer;
    const onExit = () => {
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };
    child.once("exit", onExit);
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, SHUTDOWN_GRACE_MS);
    giveUpTimer = setTimeout(() => {
      child.removeListener("exit", onExit);
      clearTimeout(killTimer);
      child.unref();
      resolve();
    }, SHUTDOWN_GRACE_MS * 2);
    try {
      child.kill("SIGTERM");
    } catch {
      // raced with exit; onExit resolves
    }
  });
  // Drop the stdio pipe handles so nothing keeps the event loop alive.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Self-check (review requirement): prove the server process is actually gone
 * before the smoke command resolves — signal 0 probes existence without
 * delivering anything.
 */
function assertServerGone(child, exitState) {
  if (!exitState.exited) {
    throw new Error(
      `self-check failed: no exit event observed for server pid ${child.pid}`,
    );
  }
  try {
    process.kill(child.pid, 0);
    throw new Error(
      `self-check failed: server pid ${child.pid} is still alive after cleanup`,
    );
  } catch (err) {
    if (err.code === "ESRCH") return; // gone — the expected outcome
    throw err;
  }
}

async function main() {
  if (!SKIP_BUILD) {
    console.log("building production bundle for the smoke check…");
    const build = spawnSync(process.execPath, [nextBin, "build"], {
      env: { ...process.env, ...exampleEnv },
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("next build failed under .env.example");
  }

  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    env: { ...process.env, ...exampleEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitState = trackExit(server);
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  let smokeError;
  try {
    const health = await (
      await waitFor(`http://localhost:${PORT}/api/health`, exitState)
    ).json();
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
  } catch (err) {
    smokeError = err;
    console.error("--- server output ---\n" + serverLog);
  } finally {
    // A cleanup failure must never mask the original smoke failure.
    try {
      await stopServer(server, exitState);
      assertServerGone(server, exitState);
      rmSync(tempDbDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      if (smokeError) {
        console.error(`cleanup also failed: ${String(cleanupErr?.message ?? cleanupErr)}`);
      } else {
        smokeError = cleanupErr;
      }
    }
  }
  if (smokeError) throw smokeError;
  console.log("self-check: server process has exited and temp state was removed");
  console.log("smoke ok: .env.example boots cleanly (health ok/fake, homepage renders)");
}

main().then(
  () => {
    process.exitCode = 0;
    // Backstop only: with the child reaped, pipes destroyed, and timers
    // cleared, the loop drains immediately and Node exits on its own. The
    // unref'd hard exit guarantees promptness even if a stray handle appears.
    setTimeout(() => process.exit(0), 3_000).unref();
  },
  (err) => {
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 3_000).unref();
  },
);
