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
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
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

const FABRIC_SHOTS = [
  { name: "00-v21-before", scenario: "idle", ui: "topology", w: 1280, h: 720 },
  { name: "01-quiet-1280x720", scenario: "idle", ui: "fabric", w: 1280, h: 720 },
  { name: "02-active-1280x720", scenario: "active", ui: "fabric", w: 1280, h: 720 },
  { name: "02b-mixed-1280x720", scenario: "container-mixed", ui: "fabric", w: 1280, h: 720 },
  { name: "03-mixed-1920x1080", scenario: "container-mixed", ui: "fabric", w: 1920, h: 1080 },
  { name: "04-real-scale-1920x1080", scenario: "container-field-real", ui: "fabric", w: 1920, h: 1080 },
  { name: "05-active-2560x1440", scenario: "active", ui: "fabric", w: 2560, h: 1440 },
  { name: "06-active-ultrawide-2560x1080", scenario: "active", ui: "fabric", w: 2560, h: 1080 },
  { name: "07-zoom-150", scenario: "active", ui: "fabric", w: 1280, h: 720, zoom: 1.5 },
  { name: "08-zoom-200", scenario: "active", ui: "fabric", w: 960, h: 540, zoom: 2 },
  { name: "09-jellyfin-focus", scenario: "transcode", ui: "fabric", w: 1920, h: 1080, action: "fabric-jellyfin" },
  { name: "10-sonarr-relationship-focus", scenario: "relationship-map", ui: "fabric", w: 1920, h: 1080, action: "fabric-sonarr" },
  { name: "10b-relationship-map", scenario: "relationship-map", ui: "fabric", relationships: true, w: 1920, h: 1080 },
  { name: "11-qbittorrent-download-focus", scenario: "downloads", ui: "fabric", w: 1920, h: 1080, action: "fabric-qbittorrent" },
  { name: "12-radarr-import", scenario: "radarr-import", ui: "fabric", w: 1920, h: 1080, action: "fabric-radarr" },
  { name: "13-same-pool-import", scenario: "same-pool-import", ui: "fabric", w: 1920, h: 1080 },
  { name: "14-cross-pool-import", scenario: "cross-pool-import", ui: "fabric", w: 1920, h: 1080 },
  { name: "15-gpu-workload", scenario: "gpu-workload", ui: "fabric", w: 1920, h: 1080 },
  { name: "16-pool-scrub", scenario: "pool-scrub", ui: "fabric", w: 1920, h: 1080 },
  { name: "17-stale", scenario: "stale", ui: "fabric", w: 1920, h: 1080 },
  { name: "18-docker-unavailable", scenario: "docker-unavailable", ui: "fabric", w: 1920, h: 1080 },
  { name: "19-reduced-motion", scenario: "active", ui: "fabric", w: 1920, h: 1080, reducedMotion: true },
  { name: "20-compact-inspector", scenario: "active", ui: "fabric", w: 1280, h: 720, action: "fabric-jellyfin" },
  { name: "20b-desktop-inspector", scenario: "active", ui: "fabric", w: 1920, h: 1080, action: "fabric-jellyfin" },
  { name: "21-technical-details", scenario: "container-field-real", ui: "fabric", w: 1920, h: 1080, action: "fabric-technical" },
];

const FABRIC_STUDY_SHOTS = [
  { study: "A+", artifactDir: "A-plus", state: "quiet", name: "01-quiet-1280x720", scenario: "idle", w: 1280, h: 720 },
  { study: "A+", artifactDir: "A-plus", state: "mixed", name: "02-mixed-1280x720", scenario: "container-mixed", w: 1280, h: 720 },
  { study: "A+", artifactDir: "A-plus", state: "mixed", name: "03-mixed-1920x1080", scenario: "container-mixed", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "real-scale", name: "04-real-scale-44-1920x1080", scenario: "container-field-real", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "focus", name: "05-jellyfin-focus-1920x1080", scenario: "transcode", focus: "service:jellyfin", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "focus", name: "06-qbittorrent-focus-1920x1080", scenario: "downloads", focus: "service:qbittorrent", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "focus", name: "07-sonarr-focus-1920x1080", scenario: "relationship-map", focus: "service:sonarr", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "focus", name: "08-subsystem-focus-1920x1080", scenario: "container-field-real", focus: "group:media-support", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "focus", name: "09-inspector-open-1280x720", scenario: "container-field-real", inspector: true, w: 1280, h: 720 },
  { study: "A+", artifactDir: "A-plus", state: "focus", name: "10-inspector-open-1920x1080", scenario: "container-field-real", inspector: true, w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "relationship-map", name: "11-relationship-map-1920x1080", scenario: "relationship-map", mode: "relationship-map", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "stale", name: "12-stale-1920x1080", scenario: "stale", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "state-only", name: "13-unknown-rate-state-only-1920x1080", scenario: "transcode-unknown-rate", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "confirmed-zero", name: "14-confirmed-zero-1920x1080", scenario: "confirmed-zero", w: 1920, h: 1080 },
  { study: "A+", artifactDir: "A-plus", state: "reduced-motion", name: "15-reduced-motion-1920x1080", scenario: "container-mixed", reducedMotion: true, w: 1920, h: 1080 },
];

const A_PLUS_ACTIVITY_SIGNATURES = new Map();

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

const FABRIC_STUDIES = process.argv.includes("--fabric-studies");
const FABRIC = !FABRIC_STUDIES && process.argv.includes("--fabric");
const SHOTS = FABRIC_STUDIES ? FABRIC_STUDY_SHOTS : FABRIC ? FABRIC_SHOTS : TOPOLOGY_SHOTS;
const OUT_DIR = arg("--out", FABRIC_STUDIES ? "docs/review/v3-server-fabric-compositions" : FABRIC ? "docs/review/v3-server-fabric" : "docs/review/v21-living-topology");
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
    case "fabric-jellyfin":
    case "fabric-sonarr":
    case "fabric-radarr":
    case "fabric-qbittorrent": {
      const id = action.slice("fabric-".length);
      const target = page.locator(`[data-fabric-node="service:${id}"]`);
      await target.focus();
      await page.keyboard.press("Enter");
      return;
    }
    case "fabric-technical": {
      const target = page.locator('[data-fabric-node^="group:"]').first();
      await target.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Technical details" }).click();
      return;
    }
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

  const fabricShot = shot.ui === "fabric";
  if (fabricShot) {
    const stage = page.locator("[data-fabric-stage]");
    if ((await stage.count()) !== 1) throw new Error(`fabric stage missing (${shot.name})`);
    if ((await page.locator("[data-fabric-node]").count()) < 12) {
      throw new Error(`fabric node population is incomplete (${shot.name})`);
    }
    const stageLabel = (await stage.getAttribute("aria-label")) ?? "";
    if (!/workloads represented/.test(stageLabel)) throw new Error(`fabric population label missing (${shot.name})`);
    const movingControl = page.locator('[data-fabric-flow-motion="true"][stroke-dasharray="3 7"]');
    if (await movingControl.count()) throw new Error(`control relationship animates (${shot.name})`);
    const inspector = page.locator("[data-fabric-inspector]");
    if (await inspector.count()) {
      if ((await inspector.locator("dl > div").count()) > 3) throw new Error(`inspector exceeds three metrics (${shot.name})`);
      if ((await inspector.locator('ul[aria-label="Relevant relationships"] > li').count()) > 5) throw new Error(`inspector exceeds five relationships (${shot.name})`);
      if (shot.w >= 1100) {
        const inspectorBox = await inspector.boundingBox();
        const nodes = page.locator("[data-fabric-node]");
        if (!inspectorBox) throw new Error(`inspector has no bounds (${shot.name})`);
        for (let index = 0; index < await nodes.count(); index++) {
          const nodeBox = await nodes.nth(index).boundingBox();
          if (!nodeBox) continue;
          const overlaps = nodeBox.x < inspectorBox.x + inspectorBox.width &&
            nodeBox.x + nodeBox.width > inspectorBox.x &&
            nodeBox.y < inspectorBox.y + inspectorBox.height &&
            nodeBox.y + nodeBox.height > inspectorBox.y;
          if (overlaps) throw new Error(`desktop inspector covers fabric node ${index} (${shot.name})`);
        }
      }
    }
    const longAttachment = await page.locator('[data-fabric-attachment-mode="stub"]').evaluateAll((paths) =>
      paths.findIndex((path) => path.getTotalLength() > 16),
    );
    if (longAttachment !== -1) throw new Error(`quiet attachment is not a local stub (${shot.name}, ${longAttachment})`);
    if (await page.locator('.fabric-member[width], .fabric-member-unknown[width], .fabric-member-attention[width]').count()) {
      throw new Error(`dense unlabeled workload microcell wall returned (${shot.name})`);
    }
    const unreadableEssentialText = await page.locator(".fabric-title, .fabric-service-title, .fabric-group-title").evaluateAll((nodes) =>
      nodes.findIndex((node) => Number.parseFloat(getComputedStyle(node).fontSize) < 8),
    );
    if (unreadableEssentialText !== -1) throw new Error(`essential fabric type is below 8px (${shot.name}, ${unreadableEssentialText})`);
    if (shot.scenario === "idle" && await page.locator("[data-fabric-route]").count()) {
      throw new Error(`quiet overview contains an end-to-end relationship trace (${shot.name})`);
    }
  } else {
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

async function validateFabricStudyShot(page, shot) {
  const result = await page.locator("[data-study-stage]").evaluate((stage, shotMetadata) => {
    const parsePoints = (value) => value.split(";").filter(Boolean).map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
    const parseBounds = (value) => {
      const [x, y, width, height] = value.split(",").map(Number);
      return { x, y, width, height };
    };
    const lines = (points) => points.slice(1).map((to, index) => [points[index], to]);
    const lineIntersectsRect = (a, b, box) => {
      if (a.x === b.x) {
        return a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
      }
      if (a.y === b.y) {
        return a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
      }
      return false;
    };
    const strictCrossing = (a1, a2, b1, b2) => {
      const ah = a1.y === a2.y;
      const bh = b1.y === b2.y;
      if (ah === bh) return false;
      const h1 = ah ? a1 : b1;
      const h2 = ah ? a2 : b2;
      const v1 = ah ? b1 : a1;
      const v2 = ah ? b2 : a2;
      return v1.x > Math.min(h1.x, h2.x) && v1.x < Math.max(h1.x, h2.x) && h1.y > Math.min(v1.y, v2.y) && h1.y < Math.max(v1.y, v2.y);
    };
    const segmentOrientation = (segment) => {
      if (segment[0].x === segment[1].x) return "vertical";
      if (segment[0].y === segment[1].y) return "horizontal";
      return "diagonal";
    };
    const orthogonalDistance = (a, b) => {
      const aOrientation = segmentOrientation(a);
      const bOrientation = segmentOrientation(b);
      if (aOrientation === "horizontal" && bOrientation === "vertical") {
        const x = b[0].x;
        const y = a[0].y;
        const dx = Math.max(0, Math.max(Math.min(a[0].x, a[1].x) - x, x - Math.max(a[0].x, a[1].x)));
        const dy = Math.max(0, Math.max(Math.min(b[0].y, b[1].y) - y, y - Math.max(b[0].y, b[1].y)));
        return Math.hypot(dx, dy);
      }
      if (aOrientation === "vertical" && bOrientation === "horizontal") {
        return orthogonalDistance(b, a);
      }
      return Number.POSITIVE_INFINITY;
    };
    const isVisibleElement = (element) => {
      const style = getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        (Number.isNaN(opacity) || opacity > 0);
    };
    const inflateBounds = (bounds, xPad, yPad) => ({
      x: bounds.x - xPad,
      y: bounds.y - yPad,
      width: bounds.width + xPad * 2,
      height: bounds.height + yPad * 2,
    });
    const shell = stage.closest("[data-study-shell]");
    const studyMode = shell?.getAttribute("data-study-mode") ?? "mixed";
    const inspectorOpen = shell?.getAttribute("data-study-inspector-open") ?? "false";
    const renderedActivityAttribute = shell?.getAttribute("data-study-rendered-activity") ??
      shell?.getAttribute("data-study-rendered-state") ??
      shell?.getAttribute("data-study-activity");
    const activityMode = shotMetadata.focus || shotMetadata.inspector ? "focus" : studyMode;

    const segmentElements = [...stage.querySelectorAll("[data-study-segment]")].filter(isVisibleElement);
    const segments = segmentElements.map((element) => {
      const group = element.closest("[data-study-segment-group]");
      const plane = group?.getAttribute("data-study-segment-plane") ?? "";
      const groupClass = group?.getAttribute("class") ?? "";
      return {
        id: element.getAttribute("data-study-segment"),
        plane,
        points: parsePoints(element.getAttribute("data-study-points") ?? ""),
        endpointA: element.getAttribute("data-study-endpoint-a") ?? "",
        endpointB: element.getAttribute("data-study-endpoint-b") ?? "",
        junctionIds: (element.getAttribute("data-study-junction-ids") ?? "").split(",").filter(Boolean),
        branch: groupClass.includes("is-branch"),
        focused: groupClass.includes("is-focused"),
        active: group?.getAttribute("data-study-segment-activity") === "live-transfer",
      };
    });
    const junctions = [...stage.querySelectorAll("[data-study-junction]")].filter(isVisibleElement).map((element) => ({
      id: element.getAttribute("data-study-junction"),
      kind: element.getAttribute("data-study-junction-kind"),
      region: element.getAttribute("data-study-junction-region") ?? "",
      crossingPairIds: (element.getAttribute("data-study-junction-crossing-pairs") ?? "").split("|").filter(Boolean),
      point: parsePoints(element.getAttribute("data-study-junction-point") ?? "")[0],
    }));
    const labels = [...stage.querySelectorAll("[data-study-segment-label]")].filter(isVisibleElement).map((element) => ({
      id: element.getAttribute("data-study-segment-label"),
      bounds: parseBounds(element.getAttribute("data-study-label-bounds") ?? "0,0,0,0"),
      text: element.querySelector("text")?.textContent ?? "",
    }));
    const geometryKeys = segments.map((segment) => {
      const forward = segment.points.map((point) => `${point.x},${point.y}`).join(";");
      const reverse = [...segment.points].reverse().map((point) => `${point.x},${point.y}`).join(";");
      return forward < reverse ? forward : reverse;
    });
    const duplicateGeometry = geometryKeys.filter((key, index) => geometryKeys.indexOf(key) !== index);
    const labelIntersections = segments.flatMap((segment) => lines(segment.points).flatMap(([a, b]) =>
      labels.filter((label) => lineIntersectsRect(a, b, label.bounds)).map((label) => `${segment.id}:${label.id}`),
    ));
    const ownerPortIds = new Map([...stage.querySelectorAll("[data-study-node]")].map((element) => [
      element.getAttribute("data-study-node"),
      [...element.querySelectorAll("[data-study-port-id]")].map((port) => port.getAttribute("data-study-port-id")),
    ]));
    const essentialText = [...stage.querySelectorAll("[data-study-essential-text]")].filter(isVisibleElement).map((element) => ({
      owner: element.getAttribute("data-owner-node"),
      role: element.getAttribute("data-study-text-role"),
      bounds: element.getBBox(),
      text: element.textContent ?? "",
    }));
    const boxesOverlap = (left, right, padding = 0) => left.x < right.x + right.width + padding && left.x + left.width + padding > right.x &&
      left.y < right.y + right.height + padding && left.y + left.height + padding > right.y;
    const textCollisions = [];
    for (let i = 0; i < essentialText.length; i++) {
      for (let j = i + 1; j < essentialText.length; j++) {
        if (essentialText[i].owner === essentialText[j].owner && boxesOverlap(essentialText[i].bounds, essentialText[j].bounds, 0.5)) {
          textCollisions.push(`${essentialText[i].owner}:${essentialText[i].text}|${essentialText[j].text}`);
        }
      }
    }
    const statusCollisions = [...stage.querySelectorAll(".fabric-study-status")].flatMap((status) => {
      const owner = status.closest("[data-study-node]")?.getAttribute("data-study-node") ?? "unknown";
      const bounds = status.getBBox();
      return essentialText
        .filter((text) => text.owner === owner && text.role !== "status" && boxesOverlap(bounds, text.bounds, 1))
        .map((text) => `${owner}:${text.text}`);
    });
    const statusTexts = essentialText.filter((item) => item.role === "status" && item.text).map((item) => item.text);
    const textIntersections = [];
    const traceTextKeepOut = [];
    for (const segment of segments) {
      for (const [a, b] of lines(segment.points)) {
        for (const text of essentialText) {
          const isEndpointText = Boolean(text.owner &&
            ownerPortIds.get(text.owner)?.some((portId) => segment.endpointA === portId || segment.endpointB === portId));
          if (text.owner && !isEndpointText && lineIntersectsRect(a, b, text.bounds)) {
            textIntersections.push(`${segment.id}:${text.owner}:${text.text}`);
          }
          if (text.owner && !isEndpointText) {
            const keepOutBounds = inflateBounds(text.bounds, 8, 8);
            if (lineIntersectsRect(a, b, keepOutBounds)) {
              traceTextKeepOut.push(`${segment.id}:${text.owner}:${text.text}`);
            }
          }
        }
      }
    }
    const nodeBounds = new Map([...stage.querySelectorAll("[data-study-node]")].filter(isVisibleElement).map((element) => [
      element.getAttribute("data-study-node"),
      parseBounds(element.getAttribute("data-study-node-bounds") ?? "0,0,0,0"),
    ]));
    const nodeStateSignature = [...nodeBounds.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))).map(([id, bounds]) =>
      `${id}|${bounds.x.toFixed(0)}|${bounds.y.toFixed(0)}|${bounds.width.toFixed(0)}|${bounds.height.toFixed(0)}`,
    );
    const textOverflow = essentialText.filter((text) => {
      if (!text.owner) return false;
      const owner = nodeBounds.get(text.owner);
      if (!owner) return true;
      const epsilon = 0.75;
      return text.bounds.x < owner.x - epsilon || text.bounds.y < owner.y - epsilon ||
        text.bounds.x + text.bounds.width > owner.x + owner.width + epsilon ||
        text.bounds.y + text.bounds.height > owner.y + owner.height + epsilon;
    }).map((text) => `${text.owner}:${text.text}`);

    const crossings = [];
    const nearCrossings = [];
    const coincidentTraces = [];
    const samePoint = (left, right) => Boolean(left && right && left.x === right.x && left.y === right.y);
    const hasSharedEndpoint = (left, right) =>
      [left.endpointA, left.endpointB].some((endpoint) => endpoint && (right.endpointA === endpoint || right.endpointB === endpoint)) ||
      left.junctionIds.some((junctionId) => right.junctionIds.includes(junctionId)) ||
      [left.points[0], left.points.at(-1)].some((point) =>
        [right.points[0], right.points.at(-1)].some((candidate) => samePoint(point, candidate)),
      );
    const hasProjectedOverlap = (a1, a2, b1, b2, axis) => {
      if (axis === "h") {
        const minA = Math.min(a1.x, a2.x);
        const maxA = Math.max(a1.x, a2.x);
        const minB = Math.min(b1.x, b2.x);
        const maxB = Math.max(b1.x, b2.x);
        return Math.min(maxA, maxB) > Math.max(minA, minB);
      }
      const minA = Math.min(a1.y, a2.y);
      const maxA = Math.max(a1.y, a2.y);
      const minB = Math.min(b1.y, b2.y);
      const maxB = Math.max(b1.y, b2.y);
      return Math.min(maxA, maxB) > Math.max(minA, minB);
    };
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const first = segments[i];
        const second = segments[j];
        const isIndependentBranchPair = first.branch && second.branch && !hasSharedEndpoint(first, second);
        const isUnrelatedRailPair = !first.branch && !second.branch && first.plane !== second.plane;
        const nearCrossingThreshold = isIndependentBranchPair ? 8 : isUnrelatedRailPair ? 12 : Number.POSITIVE_INFINITY;
        for (const [a1, a2] of lines(segments[i].points)) {
          for (const [b1, b2] of lines(segments[j].points)) {
            if (strictCrossing(a1, a2, b1, b2)) {
              const horizontal = a1.y === a2.y ? [a1, a2] : [b1, b2];
              const vertical = a1.y === a2.y ? [b1, b2] : [a1, a2];
              const crossing = { x: vertical[0].x, y: horizontal[0].y };
              const approved = junctions.some((junction) => junction.kind === "via" && junction.point?.x === crossing.x && junction.point?.y === crossing.y &&
                junction.crossingPairIds.includes(segments[i].id) && junction.crossingPairIds.includes(segments[j].id) &&
                (segments[i].junctionIds.includes(junction.id) || segments[j].junctionIds.includes(junction.id)));
              const approvedNetworkMembershipJoin = segments[i].plane === "network" && segments[j].plane === "network" &&
                ((segments[i].branch && segments[j].id.endsWith(":rail")) || (segments[j].branch && segments[i].id.endsWith(":rail")));
              if (!approved && !approvedNetworkMembershipJoin) crossings.push(`${segments[i].id}:${segments[j].id}`);
            } else {
              const aOrient = segmentOrientation([a1, a2]);
              const bOrient = segmentOrientation([b1, b2]);
              if ((aOrient === "horizontal" && bOrient === "horizontal")) {
                const overlaps = hasProjectedOverlap(a1, a2, b1, b2, "h");
                const separation = Math.abs(a1.y - b1.y);
                if (overlaps && separation === 0) {
                  coincidentTraces.push(`${segments[i].id}:${segments[j].id}`);
                } else if (overlaps && nearCrossingThreshold !== Number.POSITIVE_INFINITY && separation < nearCrossingThreshold) {
                  nearCrossings.push(`${segments[i].id}:${segments[j].id}:h=${separation.toFixed(2)}`);
                }
              } else if ((aOrient === "vertical" && bOrient === "vertical")) {
                const overlaps = hasProjectedOverlap(a1, a2, b1, b2, "v");
                const separation = Math.abs(a1.x - b1.x);
                if (overlaps && separation === 0) {
                  coincidentTraces.push(`${segments[i].id}:${segments[j].id}`);
                } else if (overlaps && nearCrossingThreshold !== Number.POSITIVE_INFINITY && separation < nearCrossingThreshold) {
                  nearCrossings.push(`${segments[i].id}:${segments[j].id}:v=${separation.toFixed(2)}`);
                }
              } else if (aOrient !== "diagonal" && bOrient !== "diagonal") {
                const distance = orthogonalDistance([a1, a2], [b1, b2]);
                if (nearCrossingThreshold !== Number.POSITIVE_INFINITY && distance < nearCrossingThreshold) {
                  nearCrossings.push(`${segments[i].id}:${segments[j].id}:d=${distance.toFixed(2)}`);
                }
              }
            }
          }
        }
      }
    }

    const occupied = parseBounds(stage.getAttribute("data-study-occupied-bounds") ?? "0,0,0,0");
    const viewBox = stage.viewBox.baseVal;
    const occupiedRatio = (occupied.width * occupied.height) / (viewBox.width * viewBox.height);
    const occupiedCenter = occupied.x + occupied.width / 2;
    const balanced = Math.abs(occupiedCenter - viewBox.width / 2) <= viewBox.width * 0.08;
    const intersectRect = (bounds, boxX, boxY, boxW, boxH) => {
      const left = Math.max(bounds.x, boxX);
      const right = Math.min(bounds.x + bounds.width, boxX + boxW);
      const top = Math.max(bounds.y, boxY);
      const bottom = Math.min(bounds.y + bounds.height, boxY + boxH);
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    };
    const longNetworkLabels = labels.filter((label) => {
      const group = stage.querySelector(`[data-study-segment-group="${label.id}"]`);
      return group?.getAttribute("data-study-segment-plane") === "network" && label.text.length > 36;
    }).map((label) => label.text);
    const dangling = segments.filter((segment) => !segment.endpointA || !segment.endpointB || segment.endpointA.startsWith("empty:") || segment.endpointB.startsWith("empty:")).map((segment) => segment.id);
    const populationIds = (stage.getAttribute("data-study-population-ids") ?? "").split(",").filter(Boolean);
    const summaryIds = new Set((stage.getAttribute("data-study-summary-ids") ?? "").split(",").filter(Boolean));
    const missingPopulation = populationIds.filter((id) => !summaryIds.has(id));
    const subsystemProblems = [...stage.querySelectorAll('[data-study-node-role="subsystem"]')].flatMap((element) => {
      const id = element.getAttribute("data-study-node") ?? "unknown";
      const memberIds = (element.getAttribute("data-study-member-ids") ?? "").split(",").filter(Boolean);
      const title = element.querySelector(".fabric-study-title")?.textContent?.trim() ?? "";
      const promotedCount = Number(element.getAttribute("data-study-promoted-count") ?? "0");
      return !title || memberIds.length === 0 || promotedCount < 1 ? [id] : [];
    });
    const ports = [...stage.querySelectorAll("[data-study-port-id]")].filter(isVisibleElement).map((element) => ({
      id: element.getAttribute("data-study-port-id"),
      kind: element.getAttribute("data-study-port-kind"),
      nodeId: element.closest("[data-study-node]")?.getAttribute("data-study-node"),
      center: parsePoints(element.getAttribute("data-study-port-center") ?? "")[0],
    }));
    const unattachedPorts = ports.filter((port) => !segments.some((segment) => {
      const endpoint = segment.endpointA === port.id ? segment.points[0] : segment.endpointB === port.id ? segment.points.at(-1) : null;
      return segment.plane === port.kind && endpoint?.x === port.center?.x && endpoint?.y === port.center?.y;
    })).map((port) => port.id);
    const routes = [...stage.querySelectorAll("[data-study-logical-route]")].map((element) => ({
      id: element.getAttribute("data-study-logical-route"),
      resolution: element.getAttribute("data-study-route-resolution") ?? "complete",
      visible: element.getAttribute("data-study-route-visible") === "true",
      fromPort: element.getAttribute("data-study-route-from-port"),
      toPort: element.getAttribute("data-study-route-to-port"),
      segmentIds: (element.getAttribute("data-study-route-segments") ?? "").split(",").filter(Boolean),
    }));
    const trunkOnlyRoutes = routes.filter((route) => route.visible && route.resolution === "complete" && (() => {
      const routeSegments = route.segmentIds.map((id) => segments.find((segment) => segment.id === id)).filter(Boolean);
      return !routeSegments.some((segment) => segment.endpointA === route.fromPort || segment.endpointB === route.fromPort) ||
        !routeSegments.some((segment) => segment.endpointA === route.toPort || segment.endpointB === route.toPort);
    })()).map((route) => route.id);
    const corridors = [...stage.querySelectorAll("[data-study-storage-corridor]")].map((element) => ({
      nodeId: element.getAttribute("data-study-storage-corridor"),
      bounds: parseBounds(element.getAttribute("data-study-corridor-bounds") ?? "0,0,0,0"),
    }));
    const blockedCorridors = corridors.flatMap((corridor) => [...stage.querySelectorAll('[data-study-node-role="subsystem"]')]
      .filter((element) => boxesOverlap(parseBounds(element.getAttribute("data-study-node-bounds") ?? "0,0,0,0"), corridor.bounds))
      .map((element) => `${corridor.nodeId}:${element.getAttribute("data-study-node")}`));
    const [densityRatio, largestVoid] = (stage.getAttribute("data-study-density") ?? "0,999").split(",").map(Number);
    const svgRect = stage.getBoundingClientRect();
    const scale = Math.min(svgRect.width / viewBox.width, svgRect.height / viewBox.height);
    const zoneWidth = viewBox.width / 3;
    const zoneRects = [
      { name: "left", x: 0, y: 0, width: zoneWidth, height: viewBox.height },
      { name: "center", x: zoneWidth, y: 0, width: zoneWidth, height: viewBox.height },
      { name: "right", x: 2 * zoneWidth, y: 0, width: viewBox.width - 2 * zoneWidth, height: viewBox.height },
    ];
    const occupancy = { left: 0, center: 0, right: 0 };
    for (const [id, bounds] of nodeBounds.entries()) {
      const target = stage.querySelector(`[data-study-node="${id}"]`);
      if (!target) continue;
      for (const zone of zoneRects) {
        const overlap = intersectRect(bounds, zone.x, zone.y, zone.width, zone.height);
        occupancy[zone.name] += overlap;
      }
    }
    const occupancyTotal = occupancy.left + occupancy.center + occupancy.right;
    const occupancyRatios = {
      left: occupancyTotal ? occupancy.left / occupancyTotal : 0,
      center: occupancyTotal ? occupancy.center / occupancyTotal : 0,
      right: occupancyTotal ? occupancy.right / occupancyTotal : 0,
    };

    const gridSize = 100;
    const cols = Math.ceil(viewBox.width / gridSize);
    const rows = Math.ceil(viewBox.height / gridSize);
    const branchDensity = Array.from({ length: rows }, () => Array.from({ length: cols }, () => new Set()));
    const branchSegments = segments.filter((segment) => segment.branch);
    for (const segment of branchSegments) {
      for (const [a, b] of lines(segment.points)) {
        const o = segmentOrientation([a, b]);
        if (o === "horizontal") {
          const y = Math.floor(((a.y + b.y) / 2) / gridSize);
          const x0 = Math.floor(Math.min(a.x, b.x) / gridSize);
          const x1 = Math.floor(Math.max(a.x, b.x) / gridSize);
          for (let x = x0; x <= x1; x++) if (x >= 0 && x < cols && y >= 0 && y < rows) branchDensity[y][x].add(segment.id);
        } else if (o === "vertical") {
          const x = Math.floor(((a.x + b.x) / 2) / gridSize);
          const y0 = Math.floor(Math.min(a.y, b.y) / gridSize);
          const y1 = Math.floor(Math.max(a.y, b.y) / gridSize);
          for (let y = y0; y <= y1; y++) if (x >= 0 && x < cols && y >= 0 && y < rows) branchDensity[y][x].add(segment.id);
        }
      }
    }
    const maxBranchDensity = branchDensity.reduce((max, row) => Math.max(max, ...row.map((cell) => cell.size)), 0);

    const typography = [...new Set([
      ...stage.querySelectorAll("[data-study-essential-text]"),
      ...stage.querySelectorAll(".fabric-study-metric-label"),
    ])].map((element) => {
      const effectiveSize = Number.parseFloat(getComputedStyle(element).fontSize) * scale;
      const role = element.getAttribute("data-study-text-role") ??
        (element.classList.contains("fabric-study-metric-label") ? "secondary" : "secondary");
      const minimum = role === "title" ? 10 : role === "tertiary" ? 8 : 9;
      return {
        effectiveSize,
        minimum,
        role,
        owner: element.getAttribute("data-owner-node") ?? element.parentElement?.getAttribute("data-owner-node"),
        text: element.textContent ?? "",
      };
    });
    const undersizedText = typography.filter((item) => item.effectiveSize + 0.001 < item.minimum)
      .map((item) => `${item.owner}:${item.text}:${item.effectiveSize.toFixed(2)}px<${item.minimum}px`);
    const minimumTypeByRole = typography.reduce((minimums, item) => {
      minimums[item.role] = Math.min(minimums[item.role] ?? Number.POSITIVE_INFINITY, item.effectiveSize);
      return minimums;
    }, {});
    const viaCountByRegion = junctions.filter((junction) => junction.kind === "via").reduce((counts, junction) => {
      const region = junction.region || "undeclared";
      counts[region] = (counts[region] ?? 0) + 1;
      return counts;
    }, {});
    const insideBounds = (candidate, bounds) => candidate.x > bounds.x && candidate.x < bounds.x + bounds.width &&
      candidate.y > bounds.y && candidate.y < bounds.y + bounds.height;
    const prohibitedVias = junctions.filter((junction) => junction.kind === "via" && (
      !junction.region || junction.crossingPairIds.length !== 2 ||
      [...nodeBounds.values()].some((bounds) => insideBounds(junction.point, bounds)) ||
      corridors.some((corridor) => insideBounds(junction.point, corridor.bounds))
    )).map((junction) => junction.id);
    const viaEvidence = junctions.filter((junction) => junction.kind === "via").map((junction) => ({
      id: junction.id,
      region: junction.region,
      crossingPairIds: junction.crossingPairIds,
    }));
    const inspectorMetrics = [...document.querySelectorAll("[data-study-inspector-metrics] > div")].length;
    const inspectorRelationships = [...document.querySelectorAll("[data-study-inspector-relationships] > li")].length;

    return {
      segmentCount: segments.length,
      duplicateGeometry,
      labelIntersections,
      textIntersections,
      textOverflow,
      textCollisions,
      statusCollisions,
      statusTexts,
      crossings,
      nearCrossings: [...new Set(nearCrossings)],
      coincidentTraces: [...new Set(coincidentTraces)],
      traceTextKeepOut,
      byModeSegmentCount: {
        quiet: shotMetadata.state === "quiet" ? segments.length : 0,
        active: shotMetadata.state === "quiet" ? 0 : segments.filter((segment) => segment.active).length,
        focus: shotMetadata.focus || shotMetadata.inspector ? segments.filter((segment) => segment.focused).length : 0,
        total: segments.length,
      },
      occupiedRatio,
      balanced,
      longNetworkLabels,
      renderedActivity: renderedActivityAttribute,
      dangling,
      populationCount: populationIds.length,
      missingPopulation,
      subsystemProblems,
      unattachedPorts,
      trunkOnlyRoutes,
      blockedCorridors,
      densityRatio,
      largestVoid,
      undersizedText,
      minimumTypeByRole,
      viaCount: junctions.filter((junction) => junction.kind === "via").length,
      viaCountByRegion,
      prohibitedVias,
      viaEvidence,
      inspectorMetrics,
      inspectorRelationships,
      studyMode,
      inspectorOpen,
      occupancyRatios,
      maxBranchDensity,
      occupancyCheckPassed: Object.values(occupancyRatios).every((ratio) => ratio > 0.08),
      activeSegmentCount: segments.filter((segment) => segment.active).length,
      focusedSegmentCount: segments.filter((segment) => segment.focused).length,
      branchSegmentCount: branchSegments.length,
      portCount: ports.length,
      viaEvidenceSummary: viaEvidence.length,
      routeCount: routes.length,
      activitySignature: {
        state: shotMetadata.state,
        activityMode,
        studyMode,
        inspectorOpen,
        nodeStateSignature,
        activeSegmentCount: segments.filter((segment) => segment.active).length,
        focusedSegmentCount: segments.filter((segment) => segment.focused).length,
        byModeSegmentCount: shotMetadata.state === "quiet"
          ? segments.length
          : shotMetadata.focus || shotMetadata.inspector
            ? segments.filter((segment) => segment.focused).length
            : segments.filter((segment) => segment.active).length,
        segmentSignature: segments.map((segment) => `${segment.id}:${segment.plane}:${segment.active ? "active" : "dormant"}:${segment.focused ? "focus" : "normal"}`).sort(),
        branchSegmentCount: branchSegments.length,
        portCount: ports.length,
        viaCount: viaEvidence.length,
      },
    };
  }, { state: shot.state, focus: Boolean(shot.focus), inspector: Boolean(shot.inspector) });

  const checkKey = `${shot.state ?? shot.name}:${shot.focus ?? (shot.inspector ? "inspector" : "none")}`;
  const signature = JSON.stringify(result.activitySignature);
  if (!A_PLUS_ACTIVITY_SIGNATURES.has(checkKey)) {
    A_PLUS_ACTIVITY_SIGNATURES.set(checkKey, signature);
  } else if (A_PLUS_ACTIVITY_SIGNATURES.get(checkKey) !== signature) {
    throw new Error(`activity-state data attributes changed for ${checkKey}: ${shot.name}`);
  }

  const failures = [];
  const minimumVisibleSegments = shot.study === "A+" && result.studyMode === "quiet" ? 3 : 5;
  if (result.segmentCount < minimumVisibleSegments) failures.push(`physical segment graph incomplete (${result.segmentCount})`);
  if (result.duplicateGeometry.length) failures.push(`duplicate physical geometry: ${result.duplicateGeometry.join(", ")}`);
  if (result.labelIntersections.length) failures.push(`segment/label intersections: ${result.labelIntersections.join(", ")}`);
  if (result.textIntersections.length) failures.push(`segment/essential-text intersections: ${result.textIntersections.join(", ")}`);
  if (result.textOverflow.length) failures.push(`text overflow: ${result.textOverflow.join(", ")}`);
  if (result.traceTextKeepOut.length) failures.push(`trace/text keep-out entries: ${result.traceTextKeepOut.join(", ")}`);
  if (result.textCollisions.length) failures.push(`essential text collisions: ${result.textCollisions.join(", ")}`);
  if (result.statusCollisions.length) failures.push(`text/status collisions: ${result.statusCollisions.join(", ")}`);
  if (result.crossings.length) failures.push(`unapproved crossings: ${result.crossings.join(", ")}`);
  if (result.studyMode === "quiet" && result.nearCrossings.length) failures.push(`near crossings below min separation: ${result.nearCrossings.slice(0, 24).join(", ")}`);
  if (result.coincidentTraces.length) failures.push(`accidental coincident traces: ${result.coincidentTraces.join(", ")}`);
  if (result.maxBranchDensity > 7) failures.push(`max branch density per 100x100 too high: ${result.maxBranchDensity}`);
  if (shot.state === "confirmed-zero") {
    if (result.renderedActivity && result.renderedActivity !== "confirmed-zero") failures.push(`confirmed-zero shot not marked by renderer (${result.renderedActivity})`);
    if (!result.renderedActivity) failures.push("confirmed-zero shot missing renderer activity data attribute");
    if (result.activeSegmentCount > 0) failures.push(`confirmed-zero shot is active (${result.activeSegmentCount})`);
  }
  if (result.studyMode === "quiet") {
    if (result.portCount > 12) failures.push(`quiet visible ports exceeds target (12): ${result.portCount}`);
    if (result.viaCount > 3) failures.push(`quiet via count exceeds target (3): ${result.viaCount}`);
  }
  if (result.studyMode === "quiet" && (result.textCollisions.length || result.traceTextKeepOut.length)) {
    failures.push("quiet mode keeps near text collisions and keep-out entries under guardrail");
  }
  if (!result.occupancyRatios || !result.occupancyRatios.left || !result.occupancyRatios.center || !result.occupancyRatios.right) {
    failures.push("unable to compute zone occupancy");
  }

  if (shot.study === "A+") {
    if (result.densityRatio < 0.34 || result.largestVoid > 8) failures.push(`composition density: ratio=${result.densityRatio.toFixed(3)} largestVoid=${result.largestVoid}`);
    if (result.unattachedPorts.length) failures.push(`visible ports without exact physical attachment: ${result.unattachedPorts.join(", ")}`);
    if (result.trunkOnlyRoutes.length) failures.push(`logical routes without endpoint branches: ${result.trunkOnlyRoutes.join(", ")}`);
    if (result.blockedCorridors.length) failures.push(`blocked primary storage corridors: ${result.blockedCorridors.join(", ")}`);
    if (result.undersizedText.length) failures.push(`persistent typography below effective minimum: ${result.undersizedText.join(", ")}`);
    if (shot.inspector && result.inspectorMetrics > 3) failures.push(`inspector exposes ${result.inspectorMetrics} first-level metrics`);
    if (shot.inspector && result.inspectorRelationships > 5) failures.push(`inspector exposes ${result.inspectorRelationships} first-level relationships`);
    if (result.viaCount > 6) failures.push(`via budget exceeded: ${result.viaCount}`);
    if (Object.values(result.viaCountByRegion).some((count) => count > 2)) failures.push(`via region budget exceeded: ${JSON.stringify(result.viaCountByRegion)}`);
    if (result.prohibitedVias.length) failures.push(`undeclared or prohibited vias: ${result.prohibitedVias.join(", ")}`);
    if (!result.occupancyCheckPassed) failures.push(`left/center/right occupancy out-of-range: ${JSON.stringify(result.occupancyRatios)}`);
  } else if (result.occupiedRatio < 0.72 || !result.balanced) failures.push(`unbalanced occupied board: ratio=${result.occupiedRatio.toFixed(3)} balanced=${result.balanced}`);
  if (result.longNetworkLabels.length) failures.push(`raw long network labels: ${result.longNetworkLabels.join(", ")}`);
  if (result.dangling.length) failures.push(`dangling dormant segments: ${result.dangling.join(", ")}`);
  if ((shot.state === "real-scale" && result.populationCount !== 44) || result.populationCount < 1 || result.missingPopulation.length) {
    failures.push(`population accounting: count=${result.populationCount}, missing=${result.missingPopulation.join(",")}`);
  }
  if (result.subsystemProblems.length) failures.push(`unnamed/unpromoted subsystem summaries: ${result.subsystemProblems.join(",")}`);

  const stage = page.locator("[data-study-stage]");
  const inspector = page.locator("[data-study-inspector]");
  if (shot.focus || shot.inspector) {
    if ((await inspector.count()) !== 1) failures.push("selected study did not render an inspector sibling");
    else {
      const insideSvg = await stage.evaluate((svg) => Boolean(svg.querySelector("[data-study-inspector]")));
      if (insideSvg) failures.push("inspector is inside SVG geometry");
      const stageBox = await stage.boundingBox();
      const inspectorBox = await inspector.boundingBox();
      if (!stageBox || !inspectorBox) failures.push("inspector or stage has no CSS box");
      else {
        const overlaps = stageBox.x < inspectorBox.x + inspectorBox.width && stageBox.x + stageBox.width > inspectorBox.x &&
          stageBox.y < inspectorBox.y + inspectorBox.height && stageBox.y + stageBox.height > inspectorBox.y;
        if (overlaps) failures.push("inspector overlaps the SVG stage");
      }
    }
  } else if (await inspector.count()) {
    failures.push("empty inspector rendered with no selection");
  }

  console.log(`${shot.name}: mode=${result.activitySignature.activityMode}, active=${result.activeSegmentCount}, focus=${result.focusedSegmentCount}, totalSegments=${result.byModeSegmentCount?.total ?? result.segmentCount}, branches=${result.branchSegmentCount}, ports=${result.portCount}, vias=${result.viaEvidenceSummary}, crossings=${result.crossings.length}, nearCrossings=${result.nearCrossings.length}, textKeepOut=${result.traceTextKeepOut.length}, coincident=${result.coincidentTraces.length}, occupancy=${JSON.stringify(result.occupancyRatios)}, branchDensity(max/100)=${result.maxBranchDensity}, largestVoid=${result.largestVoid}`);

  if (result.nearCrossings.length) {
    console.log(`near-collision summary (${shot.name}): ${result.nearCrossings.slice(0, 10).join(", ")}`);
  }
  if (result.coincidentTraces.length) {
    console.log(`coincident-trace summary (${shot.name}): ${result.coincidentTraces.slice(0, 10).join(", ")}`);
  }
  if (failures.length) throw new Error(`fabric composition evidence failed (${shot.study}/${shot.name}):\n- ${failures.join("\n- ")}`);
  if (shot.study === "A+") {
    const typeSummary = Object.fromEntries(Object.entries(result.minimumTypeByRole).map(([role, value]) => [role, Number(value.toFixed(2))]));
    console.log(`validated ${shot.name}: vias=${result.viaCount} regions=${JSON.stringify(result.viaCountByRegion)} pairs=${JSON.stringify(result.viaEvidence)} min-effective-type=${JSON.stringify(typeSummary)}px population=${result.populationCount} density=${result.densityRatio.toFixed(3)}/${result.largestVoid}`);
  }
}
/** "production" (next build+start), "development" (next dev) or "external". */
function buildMode() {
  if (arg("--base-url")) return "external";
  return PROD ? "production" : "development";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const capturedStudyStillNames = [];

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
        const params = new URLSearchParams({ scenario: shot.scenario, freeze: String(FREEZE_AT) });
        if (FABRIC_STUDIES) {
          params.set("study", shot.study);
          if (shot.focus) params.set("focus", shot.focus);
          if (shot.mode) params.set("mode", shot.mode);
          if (shot.inspector) params.set("inspector", "1");
        } else {
          if (shot.ui) params.set("ui", shot.ui);
          if (shot.relationships) params.set("relationships", "1");
          if (shot.transport) params.set("transport", shot.transport);
          if (shot.debug) params.set("debug", "geometry");
        }
        const route = FABRIC_STUDIES ? "/dev/fabric-compositions" : "/";
        await page.goto(`${baseUrl}${route}?${params}`, { waitUntil: "networkidle" });
        // Fonts + SSR hydration settle; frozen mode has no further changes.
        await page.waitForTimeout(1_200);
        const beforeActionBox = await pageBox(page);
        assertNoPageScroll(beforeActionBox, shot);
        if (FABRIC_STUDIES) mkdirSync(`${OUT_DIR}/${shot.artifactDir ?? shot.study}`, { recursive: true });
        const path = FABRIC_STUDIES ? `${OUT_DIR}/${shot.artifactDir ?? shot.study}/${shot.name}.png` : `${OUT_DIR}/${shot.name}.png`;
        // Preserve the rendered frame even when a diagnostic fails so visual
        // review can drive the next geometry iteration.
        await page.screenshot({ path });
        if (FABRIC_STUDIES) {
          await validateFabricStudyShot(page, shot);
        } else {
          await performShotAction(page, shot.action);
          await page.waitForTimeout(250);
          await validateShot(page, shot, beforeActionBox);
        }
        if (FABRIC_STUDIES) capturedStudyStillNames.push(shot.name);
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
      if (FABRIC_STUDIES && !ONLY) {
        const expectedNames = FABRIC_STUDY_SHOTS.map((shot) => shot.name).sort();
        const actualNames = [...capturedStudyStillNames].sort();
        if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
          throw new Error(`fabric-study evidence incomplete: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`);
        }
        const expectedAPlusPngs = FABRIC_STUDY_SHOTS
          .filter((shot) => shot.study === "A+")
          .map((shot) => `${shot.name}.png`)
          .sort();
        const allowedAPlusMotion = new Set([
          "motion-quiet-to-mixed-to-jellyfin-focus-to-release.gif",
          "motion-quiet-to-mixed-to-jellyfin-focus-to-release.webm",
        ]);
        const aPlusReviewFiles = readdirSync(`${OUT_DIR}/A-plus`)
          .filter((name) => /\.(?:png|gif|webm)$/i.test(name))
          .sort();
        const actualAPlusPngs = aPlusReviewFiles.filter((name) => name.endsWith(".png"));
        const unexpectedAPlusMedia = aPlusReviewFiles.filter((name) =>
          !expectedAPlusPngs.includes(name) && !allowedAPlusMotion.has(name),
        );
        if (JSON.stringify(actualAPlusPngs) !== JSON.stringify(expectedAPlusPngs) || unexpectedAPlusMedia.length > 0) {
          throw new Error(
            `A+ review directory is not exact: expected PNGs ${expectedAPlusPngs.join(", ")}; ` +
            `found ${actualAPlusPngs.join(", ")}; unexpected media ${unexpectedAPlusMedia.join(", ") || "none"}`,
          );
        }
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
  await page.goto(`${baseUrl}/?scenario=${profile.scenario}&switcher=off${FABRIC ? "&ui=fabric" : ""}`, {
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
    if (FABRIC) {
      params.set("ui", "fabric");
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
  const targetRoute = FABRIC_STUDIES
    ? `${baseUrl}/dev/fabric-compositions?study=A%2B&scenario=idle&freeze=${FREEZE_AT}`
    : `${baseUrl}/?scenario=idle&switcher=off${FABRIC ? "&ui=fabric" : ""}`;
  console.log(FABRIC_STUDIES
    ? "recording motion (same mounted A+ study): quiet → mixed → Jellyfin focus → release → quiet…"
    : "recording motion (same mounted scene): 7s idle → 13s active → 6s easing…");
  // NOT networkidle: the live page holds an SSE stream open, so the network
  // never idles. The fixture-hook wait below is the real readiness signal.
  await page.goto(targetRoute, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__homelabSetScenario === "function", {
    timeout: 15_000,
  });
  const url0 = page.url();
  const mountedStudyStage = FABRIC_STUDIES ? await page.locator("[data-study-stage]").elementHandle() : null;
  await page.waitForTimeout(3_000);
  await page.evaluate((nextScenario) => window.__homelabSetScenario(nextScenario), FABRIC_STUDIES ? "container-mixed" : "active");
  await page.waitForTimeout(4_000);
  if (FABRIC_STUDIES) {
    const node = page.locator('[data-study-node="service:jellyfin"]');
    await node.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2_000);
    await page.evaluate(() => window.__homelabSetScenario("idle"));
    await page.waitForTimeout(3_000);
  } else if (FABRIC) {
    const node = page.locator('[data-fabric-node="service:qbittorrent"]');
    await node.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3_000);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(3_000);
    await page.evaluate(() => window.__homelabSetScenario("idle"));
    await page.waitForTimeout(6_000);
  } else {
    await page.waitForTimeout(3_000);
    await page.evaluate(() => window.__homelabSetScenario("idle"));
    await page.waitForTimeout(6_000);
  }
  if (page.url() !== url0) {
    throw new Error("motion capture navigated — the same-page contract is broken");
  }
  if (mountedStudyStage && !(await mountedStudyStage.evaluate((stage) => stage === document.querySelector("[data-study-stage]")))) {
    throw new Error("motion capture remounted the A+ study — the same-mounted-component contract is broken");
  }
  const video = page.video();
  await page.close();
  await context.close();
  const webmPath = await video.path();
  const basename = FABRIC_STUDIES
    ? "motion-quiet-to-mixed-to-jellyfin-focus-to-release"
    : "motion-idle-to-active";
  const motionDir = FABRIC_STUDIES ? `${OUT_DIR}/A-plus` : OUT_DIR;
  mkdirSync(motionDir, { recursive: true });
  const target = `${motionDir}/${basename}.webm`;
  execFileSync("mv", [webmPath, target]);
  console.log(`captured ${target}`);
  // GIF for direct GitHub embedding (best-effort; needs ffmpeg).
  try {
    execFileSync("ffmpeg", [
      "-y", "-ss", "0.5", "-i", target,
      "-vf", "fps=10,scale=960:-1:flags=lanczos",
      "-loop", "0",
      `${motionDir}/${basename}.gif`,
    ], { stdio: "ignore" });
    console.log(`captured ${motionDir}/${basename}.gif`);
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
