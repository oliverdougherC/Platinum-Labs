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
 * `--motion` records the renderer story plus continuity webms (and GIFs when
 * ffmpeg is available) instead of PNGs. `--lab` captures the flow-design contact
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

const TOPOLOGY_SHOTS = [
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

// V4 Kinetic Flow Canvas evidence — captured from the PRODUCTION renderer
// (`/` with the kinetic UI mode), not the dev reference surface, against the
// deterministic fake simulator at the frozen clock. This is the full spec
// §22 graduation matrix.
const KINETIC_SHOTS = [
  { name: "01-v4-quiet-1280x720", scenario: "idle", w: 1280, h: 720 },
  { name: "02-v4-quiet-1920x1080", scenario: "idle", w: 1920, h: 1080 },
  { name: "03-v4-quiet-2560x1440", scenario: "idle", w: 2560, h: 1440 },
  { name: "04-v4-quiet-ultrawide-2560x1080", scenario: "idle", w: 2560, h: 1080 },
  { name: "05-v4-download-1920x1080", scenario: "downloads", w: 1920, h: 1080 },
  { name: "06-v4-seeding-1920x1080", scenario: "seeding", w: 1920, h: 1080 },
  { name: "07-v4-direct-play-1920x1080", scenario: "direct-play", w: 1920, h: 1080 },
  { name: "08-v4-transcode-reported-1920x1080", scenario: "transcode-reported", w: 1920, h: 1080 },
  { name: "09-v4-transcode-measured-fallback-1920x1080", scenario: "transcode-fallback", w: 1920, h: 1080 },
  { name: "10-v4-transcode-unknown-rate-1920x1080", scenario: "transcode-unknown-rate", w: 1920, h: 1080 },
  { name: "11-v4-simultaneous-1920x1080", scenario: "active", w: 1920, h: 1080 },
  { name: "12-v4-same-pool-import-1920x1080", scenario: "same-pool-import", w: 1920, h: 1080 },
  { name: "13-v4-cross-pool-import-1920x1080", scenario: "cross-pool-import", w: 1920, h: 1080 },
  { name: "14-v4-workload-field-44-1920x1080", scenario: "container-field-real", w: 1920, h: 1080 },
  { name: "15-v4-attention-1920x1080", scenario: "attention", w: 1920, h: 1080 },
  { name: "16-v4-cpu-gpu-load-1920x1080", scenario: "gpu-workload", w: 1920, h: 1080 },
  { name: "17-v4-jellyfin-inspector-1920x1080", scenario: "active", w: 1920, h: 1080, action: "kinetic-anchor:jellyfin" },
  { name: "18-v4-qbittorrent-inspector-1920x1080", scenario: "downloads", w: 1920, h: 1080, action: "kinetic-anchor:qbittorrent" },
  { name: "19-v4-workload-inspector-1920x1080", scenario: "container-field-real", w: 1920, h: 1080, action: "kinetic-cell:vaultwarden" },
  { name: "20-v4-reduced-motion-1920x1080", scenario: "active", w: 1920, h: 1080, reducedMotion: true },
  { name: "21-v4-stale-1920x1080", scenario: "stale", w: 1920, h: 1080 },
  { name: "22-v4-confirmed-zero-1920x1080", scenario: "confirmed-zero", w: 1920, h: 1080 },
  // LIVE capture (no freeze): the retained-identity contract only exists
  // across a real transport transition, which frozen mode deliberately never
  // performs. The harness waits for the stage to park before the frame.
  { name: "23-v4-docker-unavailable-retained-1920x1080", scenario: "container-field-real", w: 1920, h: 1080, transitionScenario: "docker-unavailable", live: true },
  // Equivalent zoom emulation: CSS viewport = physical 1920×1080 divided by
  // the requested browser zoom (same convention as the topology matrix).
  { name: "24-v4-zoom-150", scenario: "idle", w: 1280, h: 720, zoom: 1.5 },
  { name: "25-v4-zoom-200", scenario: "idle", w: 960, h: 540, zoom: 2 },
  // Partial known-zero truth (V4 final review blocker): activity exists, the
  // total rate is unknown — state-only breathing, no particles, no 0 B/s
  // claim. Must visibly differ from 22-v4-confirmed-zero.
  { name: "26-v4-partial-zero-unknown-1920x1080", scenario: "partial-zero", w: 1920, h: 1080 },
  // qBittorrent producer truth: active downloads keep both semantic
  // relationships visible when the aggregate transfer counter is unavailable.
  { name: "27-v4-download-rate-unknown-1920x1080", scenario: "download-rate-unknown", w: 1920, h: 1080 },
  // V4.1 workload/storage polish evidence. These extend the original V4
  // graduation matrix rather than replacing it, so regressions remain easy to
  // compare against the production baseline.
  { name: "28-v41-workload-field-44-1280x720", scenario: "container-field-real", w: 1280, h: 720 },
  { name: "29-v41-workload-field-stress-1920x1080", scenario: "container-field-stress", w: 1920, h: 1080 },
  { name: "30-v41-background-copy-datastore-esata-1920x1080", scenario: "background-copy", w: 1920, h: 1080 },
  { name: "31-v41-background-copy-reverse-1920x1080", scenario: "background-copy-reverse", w: 1920, h: 1080 },
  { name: "32-v41-background-copy-ambiguous-1920x1080", scenario: "background-copy-ambiguous", w: 1920, h: 1080 },
  {
    name: "33-v41-request-media-control-closeup",
    scenario: "idle",
    w: 1920,
    h: 1080,
    action: "request-hover",
    crop: "observatory-controls",
  },
  {
    name: "34-v41-background-copy-stale-1920x1080",
    scenario: "background-copy-stale",
    w: 1920,
    h: 1080,
  },
  {
    name: "35-v41-background-copy-live-rollup-datastore-esata-1920x1080",
    scenario: "background-copy-live-rollup",
    w: 1920,
    h: 1080,
  },
  {
    name: "36-v42-container-tooltip-high-cpu-1920x1080",
    scenario: "container-field-real",
    w: 1920,
    h: 1080,
    action: "kinetic-tooltip-hover:Image ML",
  },
  {
    name: "37-v42-container-tooltip-low-cpu-1280x720",
    scenario: "container-field-real",
    w: 1280,
    h: 720,
    action: "kinetic-tooltip-focus:vaultwarden",
  },
  {
    name: "38-v42-qb-download-panel-short-1920x1080",
    scenario: "downloads",
    w: 1920,
    h: 1080,
    action: "kinetic-download-panel",
  },
  {
    name: "39-v42-qb-download-panel-scroll-1920x1080",
    scenario: "downloads-many",
    w: 1920,
    h: 1080,
    action: "kinetic-download-panel",
  },
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

const KINETIC = process.argv.includes("--kinetic");
const SHOTS = KINETIC ? KINETIC_SHOTS : TOPOLOGY_SHOTS;
const OUT_DIR = arg("--out", KINETIC ? "docs/review/v4-kinetic-flow" : "docs/review/v21-living-topology");
const ONLY = arg("--only");
const ONLY_LOWER = ONLY?.toLowerCase() ?? null;
const MOTION = process.argv.includes("--motion");
const PERFORMANCE = process.argv.includes("--performance");
const LAB = process.argv.includes("--lab");
const DETERMINISM = process.argv.includes("--determinism");
const PROD = process.argv.includes("--prod");
const HEADLESS_PERF = process.argv.includes("--headless");
const PORT = 3911;

function wantsMotion(name, ...aliases) {
  if (!ONLY_LOWER) return true;
  return [name, ...aliases]
    .map((value) => value.toLowerCase())
    .some((value) => value.includes(ONLY_LOWER) || ONLY_LOWER.includes(value));
}

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

async function validateKineticShot(page, shot) {
  const stage = page.locator("[data-kinetic-stage]");
  if ((await stage.count()) !== 1) {
    throw new Error(`kinetic stage missing (${shot.name})`);
  }
  // Frozen frames must not run an animation loop; a live quiet scene must
  // have PARKED its loop by capture time (the harness waited for decay).
  const motion = await stage.getAttribute("data-motion");
  if (motion !== "off") {
    throw new Error(
      `${shot.live ? "parked live" : "frozen"} kinetic frame reports data-motion=${motion} (${shot.name})`,
    );
  }
  if ((await page.locator("[data-kinetic-stage] canvas").count()) !== 1) {
    throw new Error(`kinetic canvas missing (${shot.name})`);
  }
  // The upgraded CPU topology must be visible on the instrument band.
  const bandText = await page.locator("[data-kinetic-stage] header").innerText();
  if (!bandText.includes("44C / 88T")) {
    throw new Error(`instrument band lacks the detected CPU topology (${shot.name})`);
  }
  if (shot.scenario === "download-rate-unknown") {
    const anchorLabel =
      (await page.locator('[data-kinetic-anchor="qbittorrent"]').getAttribute("aria-label")) ?? "";
    const flowCopy =
      (await page.locator('[aria-label="Active data flows"]').textContent()) ?? "";
    if (!anchorLabel.includes("2 downloading") || anchorLabel.includes("B/s")) {
      throw new Error(`unknown-rate qBittorrent anchor is untruthful (${shot.name})`);
    }
    if (
      !flowCopy.includes("WAN transfer") ||
      !flowCopy.includes("staging I/O") ||
      !flowCopy.includes("rate unknown") ||
      flowCopy.includes("0 B/s")
    ) {
      throw new Error(`unknown-rate qBittorrent flow copy is untruthful (${shot.name})`);
    }
  }
  if (shot.action?.startsWith("kinetic-anchor:") || shot.action?.startsWith("kinetic-cell:")) {
    if ((await page.locator("[data-kinetic-inspector]").count()) !== 1) {
      throw new Error(`kinetic inspector did not open (${shot.name})`);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    if (await page.locator("[data-kinetic-inspector]").count()) {
      throw new Error(`Escape did not close the kinetic inspector (${shot.name})`);
    }
  }
  if (shot.action === "kinetic-download-panel") {
    const panel = page.locator("[data-download-panel]");
    if ((await panel.count()) !== 1) {
      throw new Error(`qBittorrent download panel did not open (${shot.name})`);
    }
    const expectedRows = shot.scenario === "downloads-many" ? 12 : 2;
    if ((await panel.locator("[data-download-row]").count()) !== expectedRows) {
      throw new Error(`qBittorrent download panel row count drifted (${shot.name})`);
    }
    if ((await panel.getAttribute("role")) !== "region") {
      throw new Error(`qBittorrent download panel is not a non-modal region (${shot.name})`);
    }
    if (
      !(await panel.evaluate((node) => {
        const scrollTarget = node.querySelector("[data-download-list]");
        return document.activeElement === (scrollTarget ?? node);
      }))
    ) {
      throw new Error(`keyboard focus did not enter the keyboard-scroll target (${shot.name})`);
    }
  }
  if (shot.action?.startsWith("kinetic-tooltip-")) {
    const tooltip = page.locator("[data-kinetic-container-tooltip]");
    if ((await tooltip.count()) !== 1) {
      throw new Error(`container metric tooltip missing (${shot.name})`);
    }
    await assertInsideViewport(tooltip, page, "container tooltip");
    const text = (await tooltip.innerText()).trim();
    if (!/CPU \d+(?:\.\d+)?%/.test(text) || !/\d+(?:\.\d+)? [kMGT]?B/.test(text)) {
      throw new Error(`container tooltip lacks CPU or memory (${shot.name}): ${text}`);
    }
    if (/network|block|health|image|path|container id/i.test(text.replace("Image ML", ""))) {
      throw new Error(`container tooltip contains extra metric clutter (${shot.name}): ${text}`);
    }
    const cpu = Number(text.match(/CPU (\d+(?:\.\d+)?)%/)?.[1]);
    if (shot.name.includes("high-cpu") && !(cpu > 100)) {
      throw new Error(`high-CPU fixture did not exceed 100% (${shot.name}): ${text}`);
    }
    if (shot.name.includes("low-cpu") && !(cpu > 0 && cpu < 10)) {
      throw new Error(`low-CPU fixture was not low and non-zero (${shot.name}): ${text}`);
    }
  }
  if (shot.transitionScenario === "docker-unavailable") {
    // Retained-identity contract: the field must persist as explicit
    // unknowns, with no live workload count asserted.
    if ((await page.locator("[data-kinetic-cell]").count()) === 0) {
      throw new Error(`retained topology lost the workload field (${shot.name})`);
    }
    const band = await page.locator("[data-kinetic-stage] header").innerText();
    if (/\d+\/\d+ workloads/i.test(band)) {
      throw new Error(`unavailable Docker telemetry still claims a workload count (${shot.name})`);
    }
  }
}

async function performShotAction(page, action) {
  if (action?.startsWith("kinetic-tooltip-hover:") || action?.startsWith("kinetic-tooltip-focus:")) {
    const separator = action.indexOf(":");
    const cellName = action.slice(separator + 1);
    const target = page
      .locator("[data-kinetic-cell]")
      .filter({ hasText: cellName })
      .first();
    if ((await target.count()) !== 1) {
      throw new Error(`no kinetic cell matched tooltip target: ${cellName}`);
    }
    if (action.startsWith("kinetic-tooltip-hover:")) await target.hover();
    else await target.focus();
    await page.waitForTimeout(120);
    return;
  }
  if (action?.startsWith("kinetic-anchor:")) {
    const anchorId = action.slice("kinetic-anchor:".length);
    await page.locator(`[data-kinetic-anchor="${anchorId}"]`).click();
    await page.waitForTimeout(200);
    return;
  }
  if (action?.startsWith("kinetic-cell:")) {
    const cellName = action.slice("kinetic-cell:".length);
    // Treemap tiles intentionally keep small names out of visible pixels, but
    // every tile retains its complete accessible name.
    const escapedName = cellName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page
      .getByRole("button", { name: new RegExp(`^${escapedName};`, "i") })
      .click();
    await page.waitForTimeout(200);
    return;
  }
  if (action === "kinetic-download-panel") {
    const anchor = page.locator('[data-kinetic-anchor="qbittorrent"]');
    await anchor.waitFor();
    await anchor.focus();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-kinetic-anchor="qbittorrent"]')?.getAttribute(
          "aria-expanded",
        ) === "true" && document.querySelector("[data-download-panel]"),
      { timeout: 5_000 },
    );
    await page.keyboard.press("Tab");
    await page.locator("[data-download-panel]").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("[data-download-panel]");
        if (!(panel instanceof HTMLElement)) return false;
        const scrollTarget = panel.querySelector("[data-download-list]");
        return document.activeElement === (scrollTarget ?? panel);
      },
      { timeout: 5_000 },
    );
    await page.waitForTimeout(220);
    return;
  }
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

  // Truthful V2 container accounting: rendered bodies + overflow = population.
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
        // KINETIC evidence targets the PRODUCTION homepage renderer
        // (ui=kinetic), never the dev reference surface. Live shots skip the
        // frozen clock because they exercise real transport transitions.
        const url = `${homeShotUrl(baseUrl, KINETIC ? { ...shot, ui: "kinetic" } : shot)}${shot.live ? "" : `&freeze=${FREEZE_AT}`}`;
        await page.goto(url, { waitUntil: shot.live ? "domcontentloaded" : "networkidle" });
        // Fonts + SSR hydration settle; frozen mode has no further changes.
        await page.waitForTimeout(1_200);
        const beforeActionBox = await pageBox(page);
        assertNoPageScroll(beforeActionBox, shot);
        const path = `${OUT_DIR}/${shot.name}.png`;
        if (KINETIC) {
          if (shot.transitionScenario) {
            await page.evaluate((nextScenario) => window.__homelabSetScenario(nextScenario), shot.transitionScenario);
            // Live transitions ride the real transport: allow the new
            // snapshot to arrive and the departed flows to finish decaying.
            await page.waitForTimeout(shot.live ? 6_000 : 900);
          }
          await performShotAction(page, shot.action);
          await page.waitForTimeout(250);
          // Preserve the frame even when validation fails so visual review
          // can drive the next iteration.
          if (shot.crop === "observatory-controls") {
            await page
              .getByRole("group", { name: "Observatory controls" })
              .screenshot({ path });
          } else {
            await page.screenshot({ path });
          }
          await validateKineticShot(page, shot);
        } else {
          if (shot.transitionScenario) {
            await page.evaluate((nextScenario) => window.__homelabSetScenario(nextScenario), shot.transitionScenario);
            await page.waitForTimeout(900);
          }
          await performShotAction(page, shot.action);
          await page.waitForTimeout(250);
          // Preserve the action-applied frame even when validation fails so
          // the captured artifact matches the reviewer-facing state.
          await page.screenshot({ path });
          await validateShot(page, shot, beforeActionBox);
        }
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

function homeShotUrl(baseUrl, shotLike) {
  const params = new URLSearchParams({
    scenario: shotLike.scenario,
    switcher: "off",
  });
  if (shotLike.ui === "kinetic") params.set("ui", shotLike.ui);
  if (shotLike.relationships) params.set("relationships", "1");
  if (shotLike.transport) params.set("transport", shotLike.transport);
  if (shotLike.debug) params.set("debug", "geometry");
  return `${baseUrl}/?${params}`;
}

async function measurePerformanceProfile(browser, baseUrl, profile) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: profile.reducedMotion ? "reduce" : "no-preference",
    // The frame-interval sampler below is injected page script; the
    // production CSP would block it, and it only exists in this harness.
    bypassCSP: KINETIC,
  });
  const page = await context.newPage();
  await page.goto(homeShotUrl(baseUrl, {
    scenario: profile.scenario,
    ui: KINETIC ? "kinetic" : undefined,
    relationships: profile.relationships,
    transport: profile.transport,
    debug: profile.debug,
  }), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-app-shell]");
  await page.waitForTimeout(2_000);
  if (profile.action) {
    await performShotAction(page, profile.action);
    await page.waitForTimeout(250);
  }
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

  // Kinetic frame-pacing evidence: sample real rAF intervals and long tasks
  // over the measurement window. The sampler is a passive observer — one rAF
  // subscription and a PerformanceObserver — so it costs what any animated
  // page already pays for scheduling.
  const sampleFrames = KINETIC && !profile.hidden;
  if (sampleFrames) {
    await page.evaluate(() => {
      const state = { frames: [], longTasks: 0, last: null, raf: 0 };
      window.__kineticPerfSampler = state;
      try {
        const observer = new PerformanceObserver((list) => {
          state.longTasks += list.getEntries().length;
        });
        observer.observe({ entryTypes: ["longtask"] });
        state.observer = observer;
      } catch {
        state.longTasks = null;
      }
      const loop = (t) => {
        if (state.last !== null) state.frames.push(t - state.last);
        state.last = t;
        state.raf = requestAnimationFrame(loop);
      };
      state.raf = requestAnimationFrame(loop);
    });
  }

  const start = metricMap((await client.send("Performance.getMetrics")).metrics);
  const sampleMs = KINETIC ? 10_000 : 5_000;
  await page.waitForTimeout(sampleMs);
  const end = metricMap((await client.send("Performance.getMetrics")).metrics);

  let framePacing = null;
  if (sampleFrames) {
    const sampled = await page.evaluate(() => {
      const state = window.__kineticPerfSampler;
      cancelAnimationFrame(state.raf);
      state.observer?.disconnect();
      return { frames: state.frames, longTasks: state.longTasks };
    });
    const frames = sampled.frames.slice(3); // discard sampler warm-up
    frames.sort((a, b) => a - b);
    const pct = (p) => frames.length ? Number(frames[Math.min(frames.length - 1, Math.floor((frames.length * p) / 100))].toFixed(2)) : null;
    framePacing = {
      sampledFrames: frames.length,
      p50Ms: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
      maxMs: frames.length ? Number(frames[frames.length - 1].toFixed(2)) : null,
      framesOver33Ms: frames.filter((f) => f > 33).length,
      framesOver100Ms: frames.filter((f) => f > 100).length,
      longTasks: sampled.longTasks,
    };
  }
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
    framePacing,
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
const TOPOLOGY_PERFORMANCE_BUDGET_MS_PER_S = {
  idle: 40,
  "representative-active": 80,
  "container-field-real": 100,
  "container-field-stress": 150,
  "reduced-motion": 40,
  "hidden-tab": 15,
};

const KINETIC_PERFORMANCE_BUDGET_MS_PER_S = {
  // Calibrated for the kinetic canvas on the reference capture machine:
  // while ACTIVELY animating, the renderer spends ≈1.5–1.8 ms of main-thread
  // time per 60 Hz-class frame (paint cap; intermediate vsyncs on
  // high-refresh displays are skipped), which reads as ~90–110 ms per wall
  // second. The gates exist to catch regressions from that ceiling — frame
  // pacing (p95/p99, >33 ms count, long tasks) is the smoothness claim.
  // Quiet/hidden/reduced stay strict: a parked ambient surface must cost
  // nearly nothing.
  quiet: 45,
  download: 110,
  playback: 110,
  transcode: 115,
  simultaneous: 120,
  "44-container": 130,
  "106-container": 155,
  attention: 110,
  inspector: 115,
  "reduced-motion": 40,
  "hidden-tab": 15,
};

async function capturePerformance(browser, baseUrl) {
  const profiles = KINETIC
    ? [
        { name: "quiet", scenario: "idle", reducedMotion: false, hidden: false },
        { name: "download", scenario: "downloads", reducedMotion: false, hidden: false },
        { name: "playback", scenario: "direct-play", reducedMotion: false, hidden: false },
        { name: "transcode", scenario: "transcode", reducedMotion: false, hidden: false },
        { name: "simultaneous", scenario: "active", reducedMotion: false, hidden: false },
        { name: "44-container", scenario: "container-field-real", reducedMotion: false, hidden: false },
        { name: "106-container", scenario: "container-field-stress", reducedMotion: false, hidden: false },
        { name: "attention", scenario: "attention", reducedMotion: false, hidden: false },
        { name: "inspector", scenario: "active", reducedMotion: false, hidden: false, action: "kinetic-anchor:jellyfin" },
        { name: "reduced-motion", scenario: "active", reducedMotion: true, hidden: false },
        { name: "hidden-tab", scenario: "active", reducedMotion: false, hidden: true },
      ]
    : [
        { name: "idle", scenario: "idle", reducedMotion: false, hidden: false },
        { name: "representative-active", scenario: "active", reducedMotion: false, hidden: false },
        { name: "container-field-real", scenario: "container-field-real", reducedMotion: false, hidden: false },
        { name: "container-field-stress", scenario: "container-field-stress", reducedMotion: false, hidden: false },
        { name: "reduced-motion", scenario: "active", reducedMotion: true, hidden: false },
        { name: "hidden-tab", scenario: "active", reducedMotion: false, hidden: true },
      ];
  const budgets = KINETIC
    ? KINETIC_PERFORMANCE_BUDGET_MS_PER_S
    : TOPOLOGY_PERFORMANCE_BUDGET_MS_PER_S;
  const measurements = [];
  for (const profile of profiles) {
    console.log(`measuring browser cost: ${profile.name}…`);
    const result = await measurePerformanceProfile(browser, baseUrl, profile);
    const budget = budgets[profile.name] ?? null;
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
      "Chromium CDP Performance.getMetrics; 5-second samples after a 2-second settle " +
      "(10-second samples with an rAF frame-interval + longtask observer for kinetic). " +
      "framePacing measures vsync CALLBACK delivery — a delayed/jittery interval means a busy " +
      "main thread; the kinetic renderer itself paints at a deliberate 60 Hz-class cadence and " +
      "skips intermediate vsyncs on high-refresh displays. " +
      "Committed evidence uses --prod (next build + next start) and a headful browser; " +
      "development-mode or headless numbers are for iteration only and say so here.",
    budget: {
      description:
        "Review budget: main-thread ms per wall second at 1920×1080 on the capture machine. " +
        "A quiet ambient 24/7 surface, not a benchmark score — reviewers judge the raw numbers.",
      values: budgets,
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
    if (KINETIC) {
      // The strongest kinetic determinism claim: a live-looking active scene
      // (particle field, ribbons, glow) placed purely by the frozen clock.
      params.set("ui", "kinetic");
      params.set("scenario", "active");
      params.set("switcher", "off");
      params.delete("panel");
    }
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

async function saveMotionClip(webmSourcePath, basename, outDir = OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const target = `${outDir}/${basename}.webm`;
  execFileSync("mv", [webmSourcePath, target]);
  console.log(`captured ${target}`);
  try {
    execFileSync("ffmpeg", [
      "-y", "-ss", "0.5", "-i", target,
      "-vf", "fps=10,scale=960:-1:flags=lanczos",
      "-loop", "0",
      `${outDir}/${basename}.gif`,
    ], { stdio: "ignore" });
    console.log(`captured ${outDir}/${basename}.gif`);
  } catch {
    console.warn("ffmpeg unavailable — skipped GIF; the webm is authoritative");
  }
}

/**
 * Continuity stress clip (spec §23): ONE flow identity, several magnitudes,
 * then decay interrupted by reappearance, then a final stop. Uses the dev
 * reference surface (which shares every kinetic primitive with production)
 * because only it exposes the rate-scale hook — the point of this clip is
 * that phase never resets, particles never teleport, width/density ease, and
 * mid-decay reappearance reverses cleanly.
 */
async function captureKineticContinuityStress(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    bypassCSP: true,
  });
  const page = await context.newPage();
  console.log("recording continuity stress (same mounted canvas): low → medium → high → medium → low → stop → reappear → stop…");
  await page.goto(`${baseUrl}/dev/kinetic-flow?scenario=downloads`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof window.__homelabSetScenario === "function" && typeof window.__homelabSetRateScale === "function",
    { timeout: 15_000 },
  );
  const url0 = page.url();
  const mountedStage = await page.locator("[data-kinetic-stage]").elementHandle();
  const scale = (value) => page.evaluate((s) => window.__homelabSetRateScale(s), value);
  await page.waitForTimeout(2_500);
  await scale(0.2); // low
  await page.waitForTimeout(3_500);
  await scale(1); // medium
  await page.waitForTimeout(3_500);
  await scale(6); // high
  await page.waitForTimeout(3_500);
  await scale(1); // medium
  await page.waitForTimeout(3_000);
  await scale(0.2); // low
  await page.waitForTimeout(3_000);
  // Flow stops → decay begins → the SAME flow returns 300 ms later.
  await page.evaluate(() => window.__homelabSetScenario("idle"));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__homelabSetScenario("downloads"));
  await page.waitForTimeout(3_500);
  // Final confirmed stop: terminal decay completes undisturbed.
  await page.evaluate(() => window.__homelabSetScenario("idle"));
  await page.waitForTimeout(6_000);
  if (page.url() !== url0) {
    throw new Error("continuity capture navigated — the same-page contract is broken");
  }
  if (mountedStage && !(await mountedStage.evaluate((stage) => stage === document.querySelector("[data-kinetic-stage]")))) {
    throw new Error("continuity capture remounted the kinetic stage — the same-mounted contract is broken");
  }
  const video = page.video();
  await page.close();
  await context.close();
  await saveMotionClip(await video.path(), "motion-continuity-stress");
}

/**
 * PLA-281 treemap evidence: one stable container identity grows from a small
 * measured footprint to the dominant resident workload, then yields the area
 * back. Every step mutates the same mounted fake snapshot at the normal 2s
 * sample rhythm; no navigation, remount, or fabricated production telemetry.
 */
async function captureContainerTreemapGrowth(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    bypassCSP: true,
  });
  const page = await context.newPage();
  console.log("recording container treemap growth (same tile identity): small → medium → dominant → small…");
  await page.goto(`${baseUrl}/dev/kinetic-flow?scenario=container-field-real`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () => typeof window.__homelabSetContainerMemoryScale === "function",
    { timeout: 15_000 },
  );
  const stage = await page.locator("[data-kinetic-stage]").elementHandle();
  const tile = await page
    .locator('[data-kinetic-cell="fake-immich-machine-learning"]')
    .elementHandle();
  const scale = (value) =>
    page.evaluate((next) => window.__homelabSetContainerMemoryScale(next), value);
  await scale(0.15);
  await page.waitForTimeout(2_500);
  for (const value of [0.4, 1, 2, 4, 2, 0.7, 0.2]) {
    await scale(value);
    await page.waitForTimeout(2_200);
  }
  if (stage && !(await stage.evaluate((node) => node === document.querySelector("[data-kinetic-stage]")))) {
    throw new Error("treemap growth capture remounted the kinetic stage");
  }
  if (tile && !(await tile.evaluate((node) => node.isConnected))) {
    throw new Error("treemap growth capture replaced the stable container tile");
  }
  const video = page.video();
  await page.close();
  await context.close();
  await saveMotionClip(await video.path(), "motion-container-memory-growth");
}

/**
 * PLA-286 acceptance evidence: one real-shaped DataStore → eSATA flow stays
 * continuously identifiable across a 2.2s ambiguous telemetry window (frozen
 * as last-known, never a fresh rate), resumes on the same mounted canvas, then
 * disappears once after confirmed inactivity. The ~36s clip crosses many 2s
 * simulator samples without navigation or remounting.
 */
async function captureBackgroundFlowContinuity(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    bypassCSP: true,
  });
  const page = await context.newPage();
  console.log("recording PLA-286 continuity: DataStore→eSATA → concurrent playback ambiguity → resume → confirmed stop…");
  await page.goto(`${baseUrl}/dev/kinetic-flow?scenario=background-copy`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () =>
      typeof window.__homelabSetScenario === "function" &&
      typeof window.__homelabKineticDebug === "function",
    { timeout: 15_000 },
  );
  const url0 = page.url();
  const mountedStage = await page.locator("[data-kinetic-stage]").elementHandle();
  const activeCounts = await page.evaluate(() => window.__homelabKineticDebug());
  const activeTransfer = activeCounts.visuals.find(
    (visual) => visual.kind === "background-transfer" && !visual.removed,
  );
  if (
    !activeTransfer ||
    activeTransfer.id !== "background-transfer:pool:DataStore->pool:eSATA" ||
    activeTransfer.treatment !== "particles" ||
    activeTransfer.rateBps === null
  ) {
    throw new Error(`baseline transfer did not start live: ${JSON.stringify(activeCounts)}`);
  }

  await page.waitForTimeout(8_000);
  await page.evaluate(() =>
    window.__homelabSetScenario("background-copy-playback-ambiguous"),
  );
  await page.waitForTimeout(2_200);
  const gapCounts = await page.evaluate(() => window.__homelabKineticDebug());
  const gapTransfer = gapCounts.visuals.find(
    (visual) => visual.kind === "background-transfer" && !visual.removed,
  );
  const gapPlayback = gapCounts.visuals.find(
    (visual) => visual.kind === "playback" && !visual.removed,
  );
  if (
    !gapTransfer ||
    gapTransfer.id !== activeTransfer.id ||
    gapTransfer.treatment !== "stale" ||
    gapTransfer.rateBps !== null ||
    gapTransfer.particleSlots !== 0 ||
    gapCounts.visibleParticles !== 0 ||
    gapCounts.decaying !== 0 ||
    !gapPlayback ||
    gapPlayback.treatment !== "state-only" ||
    gapPlayback.rateBps !== null
  ) {
    throw new Error(`concurrent playback ambiguity broke continuity: ${JSON.stringify(gapCounts)}`);
  }

  await page.evaluate(() => window.__homelabSetScenario("background-copy"));
  await page.waitForTimeout(12_000);
  const resumedCounts = await page.evaluate(() => window.__homelabKineticDebug());
  const resumedTransfer = resumedCounts.visuals.find(
    (visual) => visual.kind === "background-transfer" && !visual.removed,
  );
  if (
    !resumedTransfer ||
    resumedTransfer.id !== activeTransfer.id ||
    resumedTransfer.treatment !== "particles" ||
    resumedTransfer.rateBps === null ||
    resumedCounts.decaying !== 0
  ) {
    throw new Error(`resumed transfer lost continuity: ${JSON.stringify(resumedCounts)}`);
  }

  await page.evaluate(() => window.__homelabSetScenario("idle"));
  await page.waitForTimeout(7_000);
  const stoppedCounts = await page.evaluate(() => window.__homelabKineticDebug());
  if (stoppedCounts.flows !== 0 || stoppedCounts.decaying !== 0) {
    throw new Error(`confirmed stop left a ghost flow: ${JSON.stringify(stoppedCounts)}`);
  }
  await page.waitForTimeout(5_000);

  if (page.url() !== url0) {
    throw new Error("PLA-286 capture navigated — the same-page contract is broken");
  }
  if (
    mountedStage &&
    !(await mountedStage.evaluate(
      (stage) => stage === document.querySelector("[data-kinetic-stage]"),
    ))
  ) {
    throw new Error("PLA-286 capture remounted the kinetic stage");
  }
  const video = page.video();
  await page.close();
  await context.close();
  await saveMotionClip(
    await video.path(),
    "motion-background-flow-continuity-pla-286",
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
  if (KINETIC && ONLY === "container-memory-growth") {
    await captureContainerTreemapGrowth(browser, baseUrl);
    return;
  }
  if (KINETIC && ONLY?.includes("qb-download-panel")) {
    await captureQbDownloadPanelMotion(browser, baseUrl);
    return;
  }
  if (KINETIC && ONLY?.includes("background-flow-continuity")) {
    await captureBackgroundFlowContinuity(browser, baseUrl);
    return;
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    // The production build ships a CSP without 'unsafe-eval', which blocks
    // Playwright's injected waitForFunction predicate. Bypassing CSP here
    // affects only this harness context — the app under test is unchanged.
    bypassCSP: true,
  });
  const page = await context.newPage();
  const targetRoute = KINETIC
    ? `${baseUrl}/?ui=kinetic&scenario=idle&switcher=off`
    : `${baseUrl}/?scenario=idle&switcher=off`;
  console.log(KINETIC
    ? "recording motion (same mounted PRODUCTION kinetic canvas): quiet → download → playback → simultaneous → quiet…"
    : "recording motion (same mounted scene): idle → active → easing…");
  // NOT networkidle: the live page holds an SSE stream open, so the network
  // never idles. The fixture-hook wait below is the real readiness signal.
  await page.goto(targetRoute, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__homelabSetScenario === "function", {
    timeout: 15_000,
  });
  const url0 = page.url();
  const mountedKineticStage = KINETIC ? await page.locator("[data-kinetic-stage]").elementHandle() : null;
  if (KINETIC) {
    const wantsStory = wantsMotion(
      "motion-quiet-download-playback-simultaneous-quiet",
      "quiet-download-playback-simultaneous-quiet",
    );
    const wantsStress = wantsMotion("motion-continuity-stress", "continuity-stress");
    const wantsGrowth = wantsMotion(
      "motion-container-memory-growth",
      "container-memory-growth",
    );
    const wantsPla286 = wantsMotion(
      "motion-background-flow-continuity-pla-286",
      "background-flow-continuity-pla-286",
      "pla-286",
    );
    // Story clip — the required same-mounted V4 sequence, no reloads:
    // quiet → qBittorrent download → Jellyfin playback → simultaneous → quiet.
    if (wantsStory) {
      await page.waitForTimeout(3_500);
      await page.evaluate(() => window.__homelabSetScenario("downloads"));
      await page.waitForTimeout(4_500);
      await page.evaluate(() => window.__homelabSetScenario("direct-play"));
      await page.waitForTimeout(4_500);
      await page.evaluate(() => window.__homelabSetScenario("active"));
      await page.waitForTimeout(4_500);
      await page.evaluate(() => window.__homelabSetScenario("idle"));
      await page.waitForTimeout(4_000);
      if (page.url() !== url0) {
        throw new Error("motion capture navigated — the same-page contract is broken");
      }
      if (mountedKineticStage && !(await mountedKineticStage.evaluate((stage) => stage === document.querySelector("[data-kinetic-stage]")))) {
        throw new Error("motion capture remounted the kinetic stage — the same-mounted contract is broken");
      }
      const kineticVideo = page.video();
      await page.close();
      await context.close();
      await saveMotionClip(await kineticVideo.path(), "motion-quiet-download-playback-simultaneous-quiet");
    } else {
      await page.close();
      await context.close();
    }
    if (wantsStress) await captureKineticContinuityStress(browser, baseUrl);
    if (wantsGrowth) await captureContainerTreemapGrowth(browser, baseUrl);
    if (wantsPla286) await captureBackgroundFlowContinuity(browser, baseUrl);
    return;
  }

  await page.waitForTimeout(3_000);
  await page.evaluate(() => window.__homelabSetScenario("active"));
  await page.waitForTimeout(7_000);
  await page.evaluate(() => window.__homelabSetScenario("idle"));
  await page.waitForTimeout(6_000);
  if (page.url() !== url0) {
    throw new Error("motion capture navigated — the same-page contract is broken");
  }
  const video = page.video();
  await page.close();
  await context.close();
  await saveMotionClip(await video.path(), "motion-idle-to-active");
}

async function captureQbDownloadPanelMotion(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    bypassCSP: true,
  });
  const page = await context.newPage();
  console.log("recording qBittorrent panel (same mounted rows): live values update in place…");
  await page.goto(`${baseUrl}/?ui=kinetic&scenario=downloads&switcher=off`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => typeof window.__homelabSetScenario === "function", {
    timeout: 15_000,
  });
  const anchor = page.locator('[data-kinetic-anchor="qbittorrent"]');
  await anchor.waitFor();
  await anchor.focus();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-kinetic-anchor="qbittorrent"]')?.getAttribute(
        "aria-expanded",
      ) === "true" && document.querySelector("[data-download-panel]"),
    { timeout: 5_000 },
  );
  await page.keyboard.press("Tab");
  const panel = page.locator("[data-download-panel]");
  await panel.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => {
      const mountedPanel = document.querySelector("[data-download-panel]");
      if (!(mountedPanel instanceof HTMLElement)) return false;
      const scrollTarget = mountedPanel.querySelector("[data-download-list]");
      return document.activeElement === (scrollTarget ?? mountedPanel);
    },
    { timeout: 5_000 },
  );
  const mountedPanel = await panel.elementHandle();
  const mountedRows = await panel.locator("[data-download-row]").elementHandles();
  await page.waitForTimeout(2_500);
  await page.evaluate(() => window.__homelabSetScenario("downloads-progressed"));
  await page.waitForTimeout(3_000);
  await page.evaluate(() => window.__homelabSetScenario("downloads"));
  await page.waitForTimeout(2_500);
  if (!(await mountedPanel.evaluate((node) => node === document.querySelector("[data-download-panel]")))) {
    throw new Error("qBittorrent download panel remounted during a live update");
  }
  for (const row of mountedRows) {
    if (!(await row.evaluate((node) => node.isConnected))) {
      throw new Error("qBittorrent download row remounted during a live update");
    }
  }
  const video = page.video();
  await page.close();
  await context.close();
  await saveMotionClip(await video.path(), "motion-qb-download-panel-live-update");
}

if (!existsSync("package.json")) {
  console.error("run from the repository root");
  process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
