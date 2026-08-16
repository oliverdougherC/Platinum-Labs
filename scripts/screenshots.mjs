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
 *                                [--out docs/review/v2-living-topology]
 *                                [--motion] [--only <name-substring>]
 *
 * Without --base-url the harness starts `next dev` on port 3911 with
 * HOMELAB fake-mode env and tears it down afterwards. `--motion` records a
 * ~24s idle→active webm (and a GIF when ffmpeg is available) instead of PNGs.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { chromium } from "playwright";

/** Fixed simulator clock: 2026-08-15 12:00:00 UTC. */
export const FREEZE_AT = Date.UTC(2026, 7, 15, 12, 0, 0);

const SHOTS = [
  { name: "01-idle-1920x1080", params: `scenario=idle&freeze=${FREEZE_AT}`, w: 1920, h: 1080 },
  { name: "02-idle-2560x1440", params: `scenario=idle&freeze=${FREEZE_AT}`, w: 2560, h: 1440 },
  { name: "03-downloads-imports-1920x1080", params: `scenario=downloads&freeze=${FREEZE_AT}`, w: 1920, h: 1080 },
  { name: "04-jellyfin-playback-1920x1080", params: `scenario=direct-play&freeze=${FREEZE_AT}`, w: 1920, h: 1080 },
  { name: "05-notification-drawer-1920x1080", params: `scenario=attention&freeze=${FREEZE_AT}&panel=notifications`, w: 1920, h: 1080 },
  { name: "06-datastore-drawer-1920x1080", params: `scenario=active&freeze=${FREEZE_AT}&drawer=pool:DataStore`, w: 1920, h: 1080 },
  { name: "07-degraded-local-warning-1920x1080", params: `scenario=zfs-degraded&freeze=${FREEZE_AT}`, w: 1920, h: 1080 },
  // Engineering-review frame: geometry debug overlay (dev builds only —
  // the flag is compiled out of production).
  { name: "08-renderer-debug-1920x1080", params: `scenario=active&freeze=${FREEZE_AT}&debug=geometry`, w: 1920, h: 1080 },
];

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT_DIR = arg("--out", "docs/review/v2-living-topology");
const ONLY = arg("--only");
const MOTION = process.argv.includes("--motion");
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

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let baseUrl = arg("--base-url");
  let server = null;
  if (!baseUrl) {
    baseUrl = `http://localhost:${PORT}`;
    server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
      env: {
        ...process.env,
        HOMELAB_DATA_MODE: "fake",
        HOMELAB_ENABLE_DEV_CONTROLS: "1",
      },
      stdio: "ignore",
    });
  }
  await waitForServer(`${baseUrl}/api/health`);

  const browser = await chromium.launch();
  try {
    if (MOTION) {
      await captureMotion(browser, baseUrl);
    } else {
      for (const shot of SHOTS) {
        if (ONLY && !shot.name.includes(ONLY)) continue;
        const page = await browser.newPage({ viewport: { width: shot.w, height: shot.h } });
        await page.goto(`${baseUrl}/?${shot.params}`, { waitUntil: "networkidle" });
        // Fonts + SSR hydration settle; frozen mode has no further changes.
        await page.waitForTimeout(1_200);
        // HARD assertion (PLA-270): the primary surface must never scroll at
        // the target viewports — enforced here, not merely claimed in the PR.
        const box = await page.evaluate(() => ({
          docH: document.documentElement.scrollHeight,
          docW: document.documentElement.scrollWidth,
          bodyH: document.body.scrollHeight,
          winH: window.innerHeight,
          winW: window.innerWidth,
        }));
        if (box.docH > box.winH || box.bodyH > box.winH || box.docW > box.winW) {
          throw new Error(
            `page scrolls at ${shot.w}x${shot.h} (${shot.name}): ` +
              `doc ${box.docW}x${box.docH}, body h ${box.bodyH}, window ${box.winW}x${box.winH}`,
          );
        }
        const path = `${OUT_DIR}/${shot.name}.png`;
        await page.screenshot({ path });
        console.log(`captured ${path}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
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
