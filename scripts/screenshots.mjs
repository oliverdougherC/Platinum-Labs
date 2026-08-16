#!/usr/bin/env node
/**
 * Deterministic screenshot + motion-capture harness (PLA-270).
 *
 * Screenshots are part of this project's test suite: major visual changes are
 * not review-ready until these images are regenerated and visible from the PR.
 *
 * Determinism: every capture uses the fake simulator with a FIXED clock
 * (`?freeze=<epoch-ms>`), which renders one deterministic frame — no transport,
 * no animation phase, no wall-clock dependence. Same commit → same pixels
 * (modulo font rasterization across OSes; review runs use macOS).
 *
 * USAGE
 *   node scripts/screenshots.mjs [--base-url http://localhost:3900]
 *                                [--out docs/review/v21-living-topology]
 *                                [--prod] [--headless]
 *                                [--motion] [--performance] [--lab]
 *                                [--determinism]
 *                                [--only <name-substring>]
 *
 * Without --base-url the harness starts a server on port 3911 with HOMELAB
 * fake-mode env and tears it down afterwards: `next dev` by default (fast
 * iteration), or `next build` + `next start` with --prod. COMMITTED review
 * evidence (screenshots, performance JSON) must come from --prod — dev-mode
 * numbers include compilation/HMR overhead and are not production claims.
 * Every artifact records which build mode produced it.
 *
 * `--motion` records a ~24s idle→active webm (and a GIF when ffmpeg is
 * available) instead of PNGs. `--lab` captures the flow-design contact
 * sheets. `--performance` samples per-scenario browser cost — headFUL by
 * default because headless Chromium has no real GPU raster path and its
 * numbers mislead (pass --headless only for rough smoke runs; the JSON
 * records it). `--determinism` captures the same frozen state under two
 * fake system dates half a year apart and fails unless the PNGs are
 * byte-identical.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

/** Fixed simulator clock: 2026-08-15 12:00:00 UTC. */
export const FREEZE_AT = Date.UTC(2026, 7, 15, 12, 0, 0);

const SHOTS = [
  { name: "01-idle-1280x720", scenario: "idle", w: 1280, h: 720 },
  { name: "02-idle-1920x1080", scenario: "idle", w: 1920, h: 1080 },
  { name: "03-idle-2560x1440", scenario: "idle", w: 2560, h: 1440 },
  { name: "04-idle-ultrawide-2560x1080", scenario: "idle", w: 2560, h: 1080 },
  { name: "05-download-import", scenario: "downloads", w: 1920, h: 1080 },
  { name: "06-download-plus-seed", scenario: "seeding", w: 1920, h: 1080 },
  { name: "07-direct-play", scenario: "direct-play", w: 1920, h: 1080 },
  { name: "08-transcode-reported-bitrate", scenario: "transcode", w: 1920, h: 1080 },
  { name: "09-transcode-measured-fallback", scenario: "transcode-fallback", w: 1920, h: 1080 },
  { name: "10-mixed-session-coverage", scenario: "mixed-session", w: 1920, h: 1080 },
  { name: "11-pool-io", scenario: "importing", w: 1920, h: 1080 },
  { name: "12-resource-container-field", scenario: "container-mixed", w: 1920, h: 1080 },
  { name: "13-unhealthy-unknown-container", scenario: "container-mixed", w: 1920, h: 1080, action: "container-detail" },
  { name: "14-data-flow-tooltip", scenario: "downloads", w: 1920, h: 1080, action: "data-flow" },
  { name: "15-control-flow-tooltip", scenario: "downloads", w: 1920, h: 1080, action: "control-flow" },
  { name: "16-request-media-hover", scenario: "idle", w: 1920, h: 1080, action: "request-hover" },
  { name: "17-request-media-focus", scenario: "idle", w: 1920, h: 1080, action: "request-focus" },
  { name: "18-media-search-open", scenario: "idle", w: 1920, h: 1080, action: "media-search" },
  { name: "19-command-palette-open", scenario: "idle", w: 1920, h: 1080, action: "command-palette" },
  { name: "20-notifications-open", scenario: "attention", w: 1920, h: 1080, action: "notifications" },
  { name: "21-host-detail-open", scenario: "active", w: 1920, h: 1080, action: "host-detail" },
  { name: "22-transport-fallback", scenario: "idle", transport: "fallback", w: 1920, h: 1080 },
  { name: "23-data-delayed", scenario: "idle", transport: "delayed", w: 1920, h: 1080 },
  { name: "24-offline", scenario: "idle", transport: "offline", w: 1920, h: 1080 },
  { name: "25-connector-unavailable", scenario: "connector-unavailable", w: 1920, h: 1080 },
  { name: "26-stale-telemetry", scenario: "stale", w: 1920, h: 1080 },
  { name: "27-zfs-degraded", scenario: "zfs-degraded", w: 1920, h: 1080 },
  { name: "28-reduced-motion", scenario: "active", w: 1920, h: 1080, reducedMotion: true },
  // Equivalent zoom emulation: CSS viewport = physical 1920×1080 divided by
  // the requested browser zoom. This exercises the same responsive breakpoints.
  { name: "29-zoom-125", scenario: "idle", w: 1536, h: 864, zoom: 1.25 },
  { name: "30-zoom-150", scenario: "idle", w: 1280, h: 720, zoom: 1.5 },
  { name: "31-small-window-drawer", scenario: "active", w: 1280, h: 720, action: "host-detail" },
  { name: "32-renderer-debug", scenario: "active", w: 1920, h: 1080, debug: true },
  // Real-scale container evidence (PLA-272): a sanitized 44-container replay
  // of a real server population, and a stress field above the render budget.
  { name: "33-real-scale-container-field", scenario: "container-field-real", w: 1920, h: 1080 },
  { name: "34-container-field-stress", scenario: "container-field-stress", w: 1920, h: 1080 },
  // V2.1 pause + rate-evidence corrections: a paused session reads paused
  // (no glow, no flows); a genuinely playing missing-output-rate transcode
  // reads "rate unknown"; estimated rates carry ≈; and the flow detail
  // drawer exposes the full evidence chain to sighted users.
  { name: "35-paused-session", scenario: "paused", w: 1920, h: 1080 },
  { name: "36-playing-rate-unknown-tooltip", scenario: "transcode-unknown-rate", w: 1920, h: 1080, action: "playback-flow" },
  { name: "37-estimated-rate-tooltip", scenario: "direct-stream", w: 1920, h: 1080, action: "playback-flow" },
  { name: "38-flow-detail-open", scenario: "transcode", w: 1920, h: 1080, action: "flow-detail" },
];

/**
 * Truthful container accounting per scenario — the harness fails loudly if a
 * fixture is silently truncated or an expectation drifts from the fixtures.
 * rendered + overflow must equal the source population.
 */
const CONTAINER_EXPECTATIONS = {
  default: { population: 14, rendered: 14, overflow: 0 },
  "container-field-real": { population: 44, rendered: 44, overflow: 0 },
  "container-field-stress": { population: 106, rendered: 96, overflow: 10 },
};

/** Bodies that must never be hidden by overflow selection, per scenario. */
const REQUIRED_CONTAINER_TARGETS = {
  "container-field-real": ["flaresolverr", "unpackerr", "jellyfin"],
  "container-field-stress": [
    "zz-batch-failed", // unhealthy, sorts last alphabetically
    "zz-batch-unknown", // unknown state, sorts last alphabetically
    "flaresolverr",
    "unpackerr",
    "jellyfin", // highest live activity
  ],
};

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT_DIR = arg("--out", "docs/review/v21-living-topology");
const ONLY = arg("--only");
const MOTION = process.argv.includes("--motion");
const PERFORMANCE = process.argv.includes("--performance");
const LAB = process.argv.includes("--lab");
const DETERMINISM = process.argv.includes("--determinism");
const PROD = process.argv.includes("--prod");
const HEADLESS_PERF = process.argv.includes("--headless");
const PORT = 3911;

async function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${url} did not become ready`);
}

async function pageBox(page) {
  return page.evaluate(() => ({
    docH: document.documentElement.scrollHeight,
    docW: document.documentElement.scrollWidth,
    bodyH: document.body.scrollHeight,
    bodyW: document.body.scrollWidth,
    winH: window.innerHeight,
    winW: window.innerWidth,
  }));
}

function assertNoPageScroll(box, shot) {
  if (
    box.docH > box.winH ||
    box.bodyH > box.winH ||
    box.docW > box.winW ||
    box.bodyW > box.winW
  ) {
    throw new Error(
      `page scrolls at ${shot.w}x${shot.h} (${shot.name}): ` +
        `doc ${box.docW}x${box.docH}, body ${box.bodyW}x${box.bodyH}, ` +
        `window ${box.winW}x${box.winH}`,
    );
  }
}

async function focusFlow(page, needles) {
  const targets = page.locator("[data-flow-target]");
  const count = await targets.count();
  for (let i = 0; i < count; i++) {
    const target = targets.nth(i);
    const label = (await target.getAttribute("aria-label")) ?? "";
    if (needles.every((needle) => label.includes(needle))) {
      await target.focus();
      return;
    }
  }
  throw new Error(`no flow focus target matched: ${needles.join(" + ")}`);
}

async function performShotAction(page, action) {
  switch (action) {
    case undefined:
      return;
    case "container-detail":
      await page.getByRole("button", { name: /unpackerr container detail/i }).focus();
      await page.keyboard.press("Enter");
      return;
    case "data-flow":
      await focusFlow(page, ["network → qBittorrent"]);
      return;
    case "control-flow":
      await focusFlow(page, ["Sonarr → qBittorrent"]);
      return;
    case "playback-flow":
      await focusFlow(page, ["Jellyfin → network"]);
      return;
    case "flow-detail":
      await focusFlow(page, ["Jellyfin → network"]);
      await page.keyboard.press("Enter");
      return;
    case "request-hover":
      await page.getByRole("button", { name: "Request media" }).hover();
      return;
    case "request-focus":
      await page.getByRole("button", { name: "Request media" }).focus();
      return;
    case "media-search":
      await page.getByRole("button", { name: "Request media" }).focus();
      await page.keyboard.press("Enter");
      return;
    case "command-palette":
      await page.keyboard.press("Control+K");
      return;
    case "notifications":
      await page.getByRole("button", { name: /Notifications:/ }).focus();
      await page.keyboard.press("Enter");
      return;
    case "host-detail":
      await page.getByRole("button", { name: "Host compute detail" }).focus();
      await page.keyboard.press("Enter");
      return;
    default:
      throw new Error(`unknown screenshot action: ${action}`);
  }
}

async function assertInsideViewport(locator, page, label) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error(`no viewport while checking ${label}`);
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const element = locator.nth(i);
    if (!(await element.isVisible())) continue;
    const rect = await element.boundingBox();
    if (
      !rect ||
      rect.x < -0.5 ||
      rect.y < -0.5 ||
      rect.x + rect.width > viewport.width + 0.5 ||
      rect.y + rect.height > viewport.height + 0.5
    ) {
      throw new Error(`${label} ${i} is outside ${viewport.width}x${viewport.height}: ${JSON.stringify(rect)}`);
    }
  }
}

async function validateShot(page, shot, beforeActionBox) {
  const after = await pageBox(page);
  assertNoPageScroll(after, shot);
  if (
    beforeActionBox &&
    (beforeActionBox.docW !== after.docW || beforeActionBox.docH !== after.docH ||
      beforeActionBox.bodyW !== after.bodyW || beforeActionBox.bodyH !== after.bodyH)
  ) {
    throw new Error(`overlay/action changed page scroll dimensions (${shot.name})`);
  }

  const healthyChatter = await page.getByText(/updated just now/i).count();
  if (healthyChatter > 0) {
    throw new Error(`forbidden healthy freshness chatter found (${shot.name})`);
  }

  await assertInsideViewport(page.locator("header button, header [role=status]"), page, "control");
  await assertInsideViewport(page.locator("main [role=status], [data-overlay-panel]"), page, "tooltip/overlay");

  // Truthful container accounting: rendered bodies + overflow = population.
  const expected = CONTAINER_EXPECTATIONS[shot.scenario] ?? CONTAINER_EXPECTATIONS.default;
  // The trailing period distinguishes per-container bodies ("<name> container
  // detail. <state>…") from the overflow body ("… Open all container details").
  const containerTargets = page.locator('button[aria-label*=" container detail."]');
  const rendered = await containerTargets.count();
  if (rendered !== expected.rendered) {
    throw new Error(
      `rendered container count ${rendered} != expected ${expected.rendered} (${shot.name})`,
    );
  }
  const overflowTarget = page.locator('button[aria-label*="more containers"]');
  if (expected.overflow > 0) {
    const overflowLabel = (await overflowTarget.getAttribute("aria-label")) ?? "";
    if (!overflowLabel.startsWith(`${expected.overflow} more containers`)) {
      throw new Error(
        `overflow body claims "${overflowLabel}", expected ${expected.overflow} (${shot.name})`,
      );
    }
  } else if (await overflowTarget.count()) {
    throw new Error(`unexpected overflow body for a fully rendered population (${shot.name})`);
  }
  if (rendered + expected.overflow !== expected.population) {
    throw new Error(
      `rendered ${rendered} + overflow ${expected.overflow} != population ${expected.population} (${shot.name})`,
    );
  }
  for (const name of REQUIRED_CONTAINER_TARGETS[shot.scenario] ?? []) {
    if (!(await page.locator(`button[aria-label^="${name} container detail"]`).count())) {
      throw new Error(`attention/high-activity container "${name}" hidden by overflow (${shot.name})`);
    }
  }
  if ((await page.locator('button[aria-label$=" detail"]').count()) < 6) {
    throw new Error(`scene body focus targets are missing (${shot.name})`);
  }

  if (shot.action === "data-flow" || shot.action === "control-flow") {
    const tooltip = page.locator("main [role=status]");
    if ((await tooltip.count()) !== 1) throw new Error(`flow tooltip missing (${shot.name})`);
    const text = (await tooltip.innerText()).trim();
    if (/basis|coverage|source updated|provenance/i.test(text)) {
      throw new Error(`visible flow tooltip leaked verbose provenance (${shot.name}): ${text}`);
    }
  }

  const overlay = page.locator("[data-overlay-panel]");
  if (await overlay.count()) {
    const appIsInert = await page.locator("[data-app-shell]").evaluate((node) => node.inert);
    if (!appIsInert) throw new Error(`overlay did not inert the app shell (${shot.name})`);
    const focusInside = await overlay.evaluate((panel) => panel.contains(document.activeElement));
    if (!focusInside) throw new Error(`overlay did not contain focus (${shot.name})`);
  }

  if (shot.reducedMotion) {
    const motion = await page.locator("[data-app-shell]").getAttribute("data-motion");
    if (motion !== "off") throw new Error("reduced-motion still retained an active animation loop");
  }
}

/** "production" (next build+start), "development" (next dev) or "external". */
function buildMode() {
  if (arg("--base-url")) return "external";
  return PROD ? "production" : "development";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let baseUrl = arg("--base-url");
  let server = null;
  if (!baseUrl) {
    baseUrl = `http://localhost:${PORT}`;
    const serverEnv = {
      ...process.env,
      HOMELAB_DATA_MODE: "fake",
      // Runtime flag: a production build honours ?scenario=/dev fixtures only
      // with this set — without it every scenario silently measures the
      // DEFAULT_SCENARIO (a previous evidence bug).
      HOMELAB_ENABLE_DEV_CONTROLS: "1",
    };
    if (PROD) {
      console.log("building production bundle for evidence capture…");
      const build = spawnSync("npx", ["next", "build"], {
        env: serverEnv,
        stdio: "inherit",
      });
      if (build.status !== 0) throw new Error("next build failed");
      server = spawn("npx", ["next", "start", "-p", String(PORT)], {
        env: serverEnv,
        stdio: "ignore",
      });
    } else {
      server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
        env: serverEnv,
        stdio: "ignore",
      });
    }
  }
  await waitForServer(`${baseUrl}/api/health`);

  // Browser mode, stated explicitly so the evidence description can be
  // truthful: stills / motion / determinism captures run HEADLESS (the goal
  // is deterministic pixel output, and headless is what the committed
  // evidence describes). Performance sampling alone runs HEADFUL by default,
  // because headless Chromium lacks the real GPU raster/compositor path and
  // reports misleading main-thread numbers (--headless downgrades it for
  // rough iteration only, and the JSON records which mode ran).
  const browser = await chromium.launch({
    headless: PERFORMANCE ? HEADLESS_PERF : true,
  });
  try {
    if (MOTION) {
      await captureMotion(browser, baseUrl);
    } else if (PERFORMANCE) {
      await capturePerformance(browser, baseUrl);
    } else if (DETERMINISM) {
      await captureDeterminism(browser, baseUrl);
    } else if (LAB) {
      // Flow-design study (PLA-266 v2): the eleven canonical flow states under
      // each tunnel treatment, at one fixed animation clock so particle
      // placement is deterministic. Treatment A is the production choice.
      for (const treatment of ["A", "B", "C"]) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
        await page.goto(`${baseUrl}/dev/flow-lab?treatment=${treatment}&t=11.3`, {
          waitUntil: "networkidle",
        });
        await page.waitForTimeout(1_200);
        const path = `${OUT_DIR}/14-flow-design-treatment-${treatment}.png`;
        await page.screenshot({ path, fullPage: true });
        console.log(`captured ${path}`);
        await page.close();
      }
    } else {
      for (const shot of SHOTS) {
        if (ONLY && !shot.name.includes(ONLY)) continue;
        const page = await browser.newPage({
          viewport: { width: shot.w, height: shot.h },
          reducedMotion: shot.reducedMotion ? "reduce" : "no-preference",
        });
        const params = new URLSearchParams({
          scenario: shot.scenario,
          freeze: String(FREEZE_AT),
        });
        if (shot.transport) params.set("transport", shot.transport);
        if (shot.debug) params.set("debug", "geometry");
        await page.goto(`${baseUrl}/?${params}`, { waitUntil: "networkidle" });
        // Fonts + SSR hydration settle; frozen mode has no further changes.
        await page.waitForTimeout(1_200);
        const beforeActionBox = await pageBox(page);
        assertNoPageScroll(beforeActionBox, shot);
        await performShotAction(page, shot.action);
        await page.waitForTimeout(250);
        await validateShot(page, shot, beforeActionBox);
        const path = `${OUT_DIR}/${shot.name}.png`;
        await page.screenshot({ path });
        console.log(`captured ${path}`);
        if (await page.locator("[data-overlay-panel]").count()) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(50);
          if (await page.locator("[data-overlay-panel]").count()) {
            throw new Error(`Escape did not close the top overlay (${shot.name})`);
          }
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}

function metricMap(entries) {
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
}

async function measurePerformanceProfile(browser, baseUrl, profile) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: profile.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/?scenario=${profile.scenario}&switcher=off`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-app-shell]");
  await page.waitForTimeout(2_000);
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");

  let hiddenMethod = null;
  if (profile.hidden) {
    try {
      await client.send("Emulation.setPageVisibilityOverride", { visibilityState: "hidden" });
      await page.waitForFunction(() => document.hidden === true, null, { timeout: 2_000 });
      hiddenMethod = "cdp-page-visibility";
    } catch {
      // Current Playwright Chromium does not expose the experimental CDP
      // visibility override. Dispatch the exact lifecycle signal the app
      // consumes so its stop-on-hidden behavior remains measurable. This does
      // not claim to reproduce browser-level timer throttling.
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      hiddenMethod = "visibility-event-emulation";
    }
  }

  const start = metricMap((await client.send("Performance.getMetrics")).metrics);
  await page.waitForTimeout(5_000);
  const end = metricMap((await client.send("Performance.getMetrics")).metrics);
  const wallSeconds = Math.max(0.001, end.Timestamp - start.Timestamp);
  const deltaMsPerSecond = (name) =>
    Number((((end[name] - start[name]) * 1_000) / wallSeconds).toFixed(2));
  const result = {
    profile: profile.name,
    scenario: profile.scenario,
    reducedMotion: profile.reducedMotion,
    hiddenRequested: profile.hidden,
    hiddenMethod,
    documentHidden: await page.evaluate(() => document.hidden),
    sampleSeconds: Number(wallSeconds.toFixed(2)),
    mainThreadTaskMsPerSecond: deltaMsPerSecond("TaskDuration"),
    scriptMsPerSecond: deltaMsPerSecond("ScriptDuration"),
    layoutMsPerSecond: deltaMsPerSecond("LayoutDuration"),
    styleRecalcMsPerSecond: deltaMsPerSecond("RecalcStyleDuration"),
    jsHeapUsedMiB: Number((end.JSHeapUsedSize / 1024 / 1024).toFixed(2)),
    domNodes: end.Nodes,
    documents: end.Documents,
    appMotionState: await page.locator("[data-app-shell]").getAttribute("data-motion"),
  };
  await context.close();
  return result;
}

/**
 * Review thresholds for main-thread cost (ms of task time per wall second at
 * 1920×1080, production build, headful GPU). These are OUR budgets — the
 * page must stay a quiet ambient surface on a 24/7 display — not an external
 * benchmark score. Exceeding a budget prints a loud warning and is recorded
 * in the JSON for the reviewer; the raw numbers are the claim, not a grade.
 */
const PERFORMANCE_BUDGET_MS_PER_S = {
  idle: 40,
  "representative-active": 80,
  "container-field-real": 100,
  "container-field-stress": 150,
  "reduced-motion": 40,
  "hidden-tab": 15,
};

async function capturePerformance(browser, baseUrl) {
  const profiles = [
    { name: "idle", scenario: "idle", reducedMotion: false, hidden: false },
    { name: "representative-active", scenario: "active", reducedMotion: false, hidden: false },
    { name: "container-field-real", scenario: "container-field-real", reducedMotion: false, hidden: false },
    { name: "container-field-stress", scenario: "container-field-stress", reducedMotion: false, hidden: false },
    { name: "reduced-motion", scenario: "active", reducedMotion: true, hidden: false },
    { name: "hidden-tab", scenario: "active", reducedMotion: false, hidden: true },
  ];
  const measurements = [];
  for (const profile of profiles) {
    console.log(`measuring browser cost: ${profile.name}…`);
    const result = await measurePerformanceProfile(browser, baseUrl, profile);
    const budget = PERFORMANCE_BUDGET_MS_PER_S[profile.name] ?? null;
    result.budgetMainThreadMsPerSecond = budget;
    result.withinBudget =
      budget === null ? null : result.mainThreadTaskMsPerSecond <= budget;
    if (result.withinBudget === false) {
      console.warn(
        `⚠ ${profile.name}: ${result.mainThreadTaskMsPerSecond} ms/s exceeds the ${budget} ms/s review budget`,
      );
    }
    measurements.push(result);
  }
  const evidence = {
    viewport: { width: 1920, height: 1080 },
    build: buildMode(),
    headless: PERFORMANCE ? HEADLESS_PERF : true,
    method:
      "Chromium CDP Performance.getMetrics; 5-second samples after a 2-second settle. " +
      "Committed evidence uses --prod (next build + next start) and a headful browser; " +
      "development-mode or headless numbers are for iteration only and say so here.",
    budget: {
      description:
        "Review budget: main-thread ms per wall second at 1920×1080 on the capture machine. " +
        "A quiet ambient 24/7 surface, not a benchmark score — reviewers judge the raw numbers.",
      values: PERFORMANCE_BUDGET_MS_PER_S,
    },
    units: {
      mainThreadTaskMsPerSecond: "milliseconds of main-thread task time per wall second",
      scriptMsPerSecond: "milliseconds of script execution per wall second",
      layoutMsPerSecond: "milliseconds of layout work per wall second",
      styleRecalcMsPerSecond: "milliseconds of style recalculation per wall second",
    },
    measurements,
  };
  const path = `${OUT_DIR}/performance-1920x1080.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`captured ${path}`);
}

/**
 * Pixel-level determinism regression (V2.1 review blocker): the SAME frozen
 * state captured under two fake system dates half a year apart must produce
 * byte-identical PNGs — any drift means some visible surface still reads the
 * wall clock instead of the frozen snapshot clock. Runs the notification
 * drawer over the attention scenario (the densest relative-time surface).
 */
async function captureDeterminism(browser, baseUrl) {
  const SYSTEM_DATES = [
    Date.UTC(2026, 7, 16, 9, 30, 0),
    Date.UTC(2027, 1, 3, 22, 45, 11),
  ];
  const hashes = [];
  for (const fakeNow of SYSTEM_DATES) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.clock.install({ time: fakeNow });
    const params = new URLSearchParams({
      scenario: "attention",
      freeze: String(FREEZE_AT),
      panel: "notifications",
    });
    await page.goto(`${baseUrl}/?${params}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1_200);
    const png = await page.screenshot();
    hashes.push({ fakeNow, sha256: createHash("sha256").update(png).digest("hex"), png });
    await context.close();
  }
  if (hashes[0].sha256 !== hashes[1].sha256) {
    for (const { fakeNow, png } of hashes) {
      const path = `${OUT_DIR}/determinism-failure-${fakeNow}.png`;
      writeFileSync(path, png);
      console.error(`wrote ${path}`);
    }
    throw new Error(
      `frozen frame differs across system dates: ${hashes[0].sha256} != ${hashes[1].sha256}`,
    );
  }
  console.log(
    `determinism ok: identical frozen pixels under two system dates (sha256 ${hashes[0].sha256.slice(0, 12)}…)`,
  );
}

/**
 * Motion capture (PLA-270): ONE mounted renderer, telemetry changing in
 * place. The scenario switches through the dev fixture hook
 * (`window.__homelabSetScenario`) — never via navigation or reload — so the
 * clip demonstrates the interpolation system itself: calm idle, activity
 * ramping in (flows appear, the relevant bodies wake, storage I/O lights),
 * then easing back toward idle.
 */
async function captureMotion(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    // The production build ships a CSP without 'unsafe-eval', which blocks
    // Playwright's injected waitForFunction predicate. Bypassing CSP here
    // affects only this harness context — the app under test is unchanged.
    bypassCSP: true,
  });
  const page = await context.newPage();
  console.log("recording motion (same mounted scene): 7s idle → 13s active → 6s easing…");
  // NOT networkidle: the live page holds an SSE stream open, so the network
  // never idles. The fixture-hook wait below is the real readiness signal.
  await page.goto(`${baseUrl}/?scenario=idle&switcher=off`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__homelabSetScenario === "function", {
    timeout: 15_000,
  });
  const url0 = page.url();
  await page.waitForTimeout(7_000);
  await page.evaluate(() => window.__homelabSetScenario("active"));
  await page.waitForTimeout(13_000);
  await page.evaluate(() => window.__homelabSetScenario("idle"));
  await page.waitForTimeout(6_000);
  if (page.url() !== url0) {
    throw new Error("motion capture navigated — the same-page contract is broken");
  }
  const video = page.video();
  await page.close();
  await context.close();
  const webmPath = await video.path();
  const target = `${OUT_DIR}/motion-idle-to-active.webm`;
  execFileSync("mv", [webmPath, target]);
  console.log(`captured ${target}`);
  // GIF for direct GitHub embedding (best-effort; needs ffmpeg).
  try {
    execFileSync("ffmpeg", [
      "-y", "-i", target,
      "-vf", "fps=10,scale=960:-1:flags=lanczos",
      "-loop", "0",
      `${OUT_DIR}/motion-idle-to-active.gif`,
    ], { stdio: "ignore" });
    console.log(`captured ${OUT_DIR}/motion-idle-to-active.gif`);
  } catch {
    console.warn("ffmpeg unavailable — skipped GIF; the webm is authoritative");
  }
}

if (!existsSync("package.json")) {
  console.error("run from the repository root");
  process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
