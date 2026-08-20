#!/usr/bin/env node
/**
 * Kinetic Canvas long-running soak harness (V4 release blocker).
 *
 * The dashboard is meant to sit on a second monitor for HOURS, so "the
 * animation runs" is not the bar — bounded memory, bounded listeners, one
 * animation loop, and no slow degradation are. This harness keeps ONE
 * mounted production kinetic stage alive for the full duration (no reloads),
 * cycles realistic operational states through the same fixture hook the
 * motion harness uses, and samples browser internals at fixed intervals.
 *
 * USAGE
 *   npm run soak:kinetic                      # 90-minute production soak
 *   node scripts/soak-kinetic.mjs --minutes 5 # short smoke iteration
 *                                  [--base-url http://localhost:3911]
 *                                  [--out docs/review/v4-kinetic-flow/soak-90min.json]
 *                                  [--headless]
 *
 * Committed evidence must come from the default configuration: production
 * build (`next build` + `next start`), HEADFUL Chromium at 1920×1080, 90
 * minutes. The JSON records what actually ran.
 *
 * Collected per sample (default every 5 minutes):
 *  - JS heap used, DOM nodes, JS event listeners, documents;
 *  - main-thread/script ms per wall second since the previous sample;
 *  - layout + style-recalc counts since the previous sample;
 *  - long tasks since the previous sample (PerformanceObserver);
 *  - engine counters (live flows, decaying ghosts, bounded particle count,
 *    rAF active) via the dev-controls debug hook;
 *  - canvas backing-store dimensions.
 *
 * At the end the harness forces GC through CDP and compares retained heap
 * with the GC'd baseline taken after the first cycle settles. Bounded
 * behavior is required; byte-identical numbers are not.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MINUTES = Number(arg("--minutes", "90"));
const OUT = arg("--out", "docs/review/v4-kinetic-flow/soak-90min.json");
const HEADLESS = process.argv.includes("--headless");
const SAMPLE_EVERY_MS = Number(arg("--sample-seconds", "300")) * 1000;
const PORT = 3912;

/**
 * One realistic operational cycle. Rates inside a scenario also move on
 * their own: the fake simulator wobbles measured rates against the live
 * clock, so every 2-second snapshot is a genuine target change.
 */
const CYCLE = [
  { scenario: "idle", seconds: 90 },
  { scenario: "downloads", seconds: 150 },
  { scenario: "seeding", seconds: 120 },
  { scenario: "direct-play", seconds: 120 },
  { scenario: "transcode", seconds: 150 },
  { scenario: "active", seconds: 180, interact: true },
  { scenario: "cross-pool-import", seconds: 120 },
  { scenario: "idle", seconds: 90 },
  { scenario: "attention", seconds: 120, interact: true },
  { scenario: "idle", seconds: 60 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function metricMap(entries) {
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
}

async function waitForServer(url, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`server at ${url} did not become ready`);
}

async function forceGc(client) {
  await client.send("HeapProfiler.enable");
  for (let i = 0; i < 3; i++) {
    await client.send("HeapProfiler.collectGarbage");
    await sleep(400);
  }
}

async function main() {
  let baseUrl = arg("--base-url");
  let server = null;
  const buildMode = baseUrl ? "external" : "production";
  if (!baseUrl) {
    baseUrl = `http://localhost:${PORT}`;
    const serverEnv = {
      ...process.env,
      HOMELAB_DATA_MODE: "fake",
      HOMELAB_ENABLE_DEV_CONTROLS: "1",
    };
    console.log("building production bundle for the soak…");
    const build = spawnSync("npx", ["next", "build"], { env: serverEnv, stdio: "inherit" });
    if (build.status !== 0) throw new Error("next build failed");
    server = spawn("npx", ["next", "start", "-p", String(PORT)], {
      env: serverEnv,
      stdio: "ignore",
    });
  }
  await waitForServer(`${baseUrl}/api/health`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const samples = [];
  const failures = [];
  let baseline = null;
  let finalAfterGc = null;

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      bypassCSP: true,
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?ui=kinetic&scenario=idle&switcher=off`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () =>
        typeof window.__homelabSetScenario === "function" &&
        typeof window.__homelabKineticDebug === "function",
      { timeout: 20_000 },
    );
    const url0 = page.url();
    const mountedStage = await page.locator("[data-kinetic-stage]").elementHandle();
    if (!mountedStage) throw new Error("kinetic stage did not mount");

    // Long tasks accumulate in the page between samples.
    await page.evaluate(() => {
      window.__soakLongTasks = 0;
      try {
        const observer = new PerformanceObserver((list) => {
          window.__soakLongTasks += list.getEntries().length;
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        window.__soakLongTasks = null;
      }
    });

    const client = await context.newCDPSession(page);
    await client.send("Performance.enable");

    let prevMetrics = null;
    let lastLongTasks = 0;
    const takeSample = async (label) => {
      const metrics = metricMap((await client.send("Performance.getMetrics")).metrics);
      const debug = await page.evaluate(() => window.__homelabKineticDebug());
      const canvas = await page.evaluate(() => {
        const el = document.querySelector("[data-kinetic-stage] canvas");
        return el ? { width: el.width, height: el.height } : null;
      });
      const longTasksTotal = await page.evaluate(() => window.__soakLongTasks);
      const stageIntact = await mountedStage.evaluate(
        (stage) => stage === document.querySelector("[data-kinetic-stage]"),
      );
      const canvasCount = await page.locator("[data-kinetic-stage] canvas").count();
      const wall = prevMetrics ? Math.max(0.001, metrics.Timestamp - prevMetrics.Timestamp) : null;
      const rate = (name) =>
        prevMetrics && wall
          ? Number((((metrics[name] - prevMetrics[name]) * 1000) / wall).toFixed(2))
          : null;
      const delta = (name) => (prevMetrics ? metrics[name] - prevMetrics[name] : null);
      const sample = {
        label,
        atMinutes: Number(((Date.now() - startedAt) / 60_000).toFixed(2)),
        jsHeapUsedMiB: Number((metrics.JSHeapUsedSize / 1024 / 1024).toFixed(2)),
        domNodes: metrics.Nodes,
        jsEventListeners: metrics.JSEventListeners,
        documents: metrics.Documents,
        mainThreadTaskMsPerSecond: rate("TaskDuration"),
        scriptMsPerSecond: rate("ScriptDuration"),
        layoutCountDelta: delta("LayoutCount"),
        styleRecalcCountDelta: delta("RecalcStyleCount"),
        longTasksDelta:
          longTasksTotal === null ? null : longTasksTotal - lastLongTasks,
        engine: debug,
        canvas,
        canvasCount,
        stageIntact,
        pageUrlStable: page.url() === url0,
      };
      prevMetrics = metrics;
      if (longTasksTotal !== null) lastLongTasks = longTasksTotal;
      samples.push(sample);
      console.log(
        `[${sample.atMinutes.toFixed(1)}m] ${label}: heap ${sample.jsHeapUsedMiB} MiB, ` +
          `nodes ${sample.domNodes}, listeners ${sample.jsEventListeners}, ` +
          `flows ${debug.flows} (decaying ${debug.decaying}), particles ${debug.visibleParticles}, ` +
          `raf ${debug.rafActive}`,
      );
      if (!stageIntact) failures.push(`stage remounted by ${sample.atMinutes} minutes`);
      if (!sample.pageUrlStable) failures.push("page navigated during soak");
      if (canvasCount !== 1) failures.push(`canvas count ${canvasCount} at ${sample.atMinutes} minutes`);
      return sample;
    };

    const startedAt = Date.now();
    const endAt = startedAt + MINUTES * 60_000;
    console.log(`soaking the mounted production kinetic stage for ${MINUTES} minutes…`);

    // Settle, then take a GC'd baseline early so end-of-run retention has an
    // honest comparison point.
    await sleep(Math.min(60_000, MINUTES * 60_000 * 0.05));
    await forceGc(client);
    baseline = await takeSample("baseline-after-gc");

    let nextSampleAt = Date.now() + SAMPLE_EVERY_MS;
    let phaseIndex = 0;
    let interactedInPhase = false;
    let phaseEndsAt = 0;

    while (Date.now() < endAt) {
      if (Date.now() >= phaseEndsAt) {
        const phase = CYCLE[phaseIndex % CYCLE.length];
        phaseIndex += 1;
        interactedInPhase = false;
        phaseEndsAt = Date.now() + phase.seconds * 1000;
        await page.evaluate((s) => window.__homelabSetScenario(s), phase.scenario);
        console.log(`phase → ${phase.scenario} (${phase.seconds}s)`);
      }
      const phase = CYCLE[(phaseIndex - 1) % CYCLE.length];
      if (phase.interact && !interactedInPhase && Date.now() > phaseEndsAt - phase.seconds * 500) {
        // Selection open/close mid-phase: the inspector must come and go
        // without leaking listeners or duplicating loops.
        interactedInPhase = true;
        await page.locator('[data-kinetic-anchor="jellyfin"]').click();
        await sleep(8_000);
        await page.keyboard.press("Escape");
      }
      if (Date.now() >= nextSampleAt) {
        nextSampleAt += SAMPLE_EVERY_MS;
        await takeSample("interval");
      }
      await sleep(1_000);
    }

    // Wind down to quiet, force GC, and measure retention.
    await page.evaluate(() => window.__homelabSetScenario("idle"));
    await sleep(10_000);
    await forceGc(client);
    finalAfterGc = await takeSample("final-after-gc");

    // --- bounded-behavior gates -------------------------------------------
    const heapLimit = baseline.jsHeapUsedMiB * 1.35 + 25;
    if (finalAfterGc.jsHeapUsedMiB > heapLimit) {
      failures.push(
        `retained heap grew from ${baseline.jsHeapUsedMiB} to ${finalAfterGc.jsHeapUsedMiB} MiB (limit ${heapLimit.toFixed(1)})`,
      );
    }
    if (finalAfterGc.jsEventListeners > baseline.jsEventListeners + 64) {
      failures.push(
        `event listeners grew from ${baseline.jsEventListeners} to ${finalAfterGc.jsEventListeners}`,
      );
    }
    if (finalAfterGc.domNodes > baseline.domNodes * 1.3 + 500) {
      failures.push(`DOM nodes grew from ${baseline.domNodes} to ${finalAfterGc.domNodes}`);
    }
    for (const sample of samples) {
      const engine = sample.engine;
      if (engine.flows > 16) failures.push(`unbounded flow visuals (${engine.flows}) at ${sample.atMinutes}m`);
      if (engine.decaying > 16) failures.push(`ghost flows accumulating (${engine.decaying}) at ${sample.atMinutes}m`);
      if (engine.visibleParticles > 16 * 2 * 42) failures.push(`runaway particle state (${engine.visibleParticles}) at ${sample.atMinutes}m`);
      if (engine.cells > 150) failures.push(`unbounded cell visuals (${engine.cells}) at ${sample.atMinutes}m`);
    }
    // Sustained-trend check on intermediate samples (heap between GCs may
    // legitimately sawtooth; a monotone climb across EVERY sample is a leak
    // signature).
    const interval = samples.filter((s) => s.label === "interval");
    if (interval.length >= 4) {
      const strictlyClimbing = interval.every(
        (s, i) => i === 0 || s.jsHeapUsedMiB > interval[i - 1].jsHeapUsedMiB + 0.5,
      );
      if (strictlyClimbing) {
        failures.push("JS heap climbed monotonically across every interval sample");
      }
    }

    await context.close();
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  const report = {
    capturedAt: new Date().toISOString(),
    minutes: MINUTES,
    viewport: { width: 1920, height: 1080 },
    build: buildMode,
    headless: HEADLESS,
    surface: "/?ui=kinetic (production renderer, live fake transport)",
    cycle: CYCLE,
    sampleEverySeconds: SAMPLE_EVERY_MS / 1000,
    method:
      "One mounted production kinetic stage, no reloads. Scenario cycling via the dev fixture hook; " +
      "CDP Performance.getMetrics per sample; PerformanceObserver longtask deltas; engine counters via " +
      "__homelabKineticDebug; HeapProfiler.collectGarbage before the baseline and final samples. " +
      "Gates require bounded behavior, not byte-identical numbers.",
    baselineAfterGc: baseline,
    finalAfterGc,
    samples,
    failures,
    passed: failures.length === 0,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
  if (failures.length > 0) {
    console.error(`SOAK FAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(
    `soak passed: heap ${baseline.jsHeapUsedMiB} → ${finalAfterGc.jsHeapUsedMiB} MiB after GC, ` +
      `listeners ${baseline.jsEventListeners} → ${finalAfterGc.jsEventListeners}, ` +
      `nodes ${baseline.domNodes} → ${finalAfterGc.domNodes}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
