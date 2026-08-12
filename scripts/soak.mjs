#!/usr/bin/env node
// Continuous-display soak harness (PLA-197).
//
// Polls the running dashboard like a browser would and periodically samples the
// signals that matter for a 24/7 secondary-monitor deployment: server process
// memory (RSS), SQLite file size + row counts, and poll success/failure counts.
// It writes newline-delimited JSON so growth can be charted afterwards.
//
// It does NOT prove a 24-hour run by itself — it is the instrument. Point it at a
// real server for the real duration (see docs/SOAK.md). No dependencies.
//
// Usage:
//   node scripts/soak.mjs --url http://localhost:3000 --duration 86400 \
//     --interval 7 --sample 60 --pid <server-pid> --db ./data/homelab.db \
//     --out soak-report.ndjson

import { appendFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const url = arg("url", "http://localhost:3000");
const durationS = Number(arg("duration", "86400")); // 24h default
const intervalS = Number(arg("interval", "7")); // browser-like poll cadence
const sampleS = Number(arg("sample", "60")); // how often to record a sample row
const pid = arg("pid", ""); // server process id, for RSS sampling
const dbPath = arg("db", "./data/homelab.db");
const out = arg("out", "soak-report.ndjson");

const startedAt = Date.now();
let polls = 0;
let failures = 0;
let lastStatus = 0;

function rssKb(p) {
  if (!p) return null;
  try {
    // ps rss is in KB on macOS/Linux.
    const o = execFileSync("ps", ["-o", "rss=", "-p", String(p)], { encoding: "utf8" });
    const n = Number(o.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function dbBytes() {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      /* file may not exist yet */
    }
  }
  return total;
}

async function pollOnce() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(`${url}/api/dashboard`, { signal: ac.signal, cache: "no-store" });
    lastStatus = res.status;
    await res.arrayBuffer(); // drain body like a browser
    if (!res.ok) failures += 1;
  } catch {
    failures += 1;
    lastStatus = 0;
  } finally {
    clearTimeout(timer);
    polls += 1;
  }
}

function sample() {
  const row = {
    t: new Date(startedAt + (Date.now() - startedAt)).toISOString(),
    elapsedS: Math.round((Date.now() - startedAt) / 1000),
    polls,
    failures,
    lastStatus,
    serverRssKb: rssKb(pid),
    dbBytes: dbBytes(),
  };
  appendFileSync(out, JSON.stringify(row) + "\n");
  const rss = row.serverRssKb ? `${(row.serverRssKb / 1024).toFixed(1)}MB` : "n/a";
  const db = `${(row.dbBytes / 1024).toFixed(0)}KB`;
  console.log(
    `[${row.elapsedS}s] polls=${polls} fails=${failures} status=${lastStatus} rss=${rss} db=${db}`,
  );
}

console.log(`soak: ${url} for ${durationS}s (poll ${intervalS}s, sample ${sampleS}s) → ${out}`);

let lastSampleAt = 0;
const endAt = startedAt + durationS * 1000;
sample(); // baseline

while (Date.now() < endAt) {
  await pollOnce();
  if (Date.now() - lastSampleAt >= sampleS * 1000) {
    sample();
    lastSampleAt = Date.now();
  }
  await new Promise((r) => setTimeout(r, intervalS * 1000));
}
sample(); // final
console.log(`soak complete: ${polls} polls, ${failures} failures. Report: ${out}`);
