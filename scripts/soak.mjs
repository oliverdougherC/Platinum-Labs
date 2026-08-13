#!/usr/bin/env node
// Continuous-display soak harness (PLA-197).
//
// Polls the running dashboard like a browser would and periodically samples the
// signals that matter for a 24/7 secondary-monitor deployment: request
// failures, container/server RSS, and SQLite physical/logical growth. It writes
// newline-delimited JSON so a literal 24-hour run can be reviewed afterwards.
//
// Usage:
//   node scripts/soak.mjs --url http://localhost:3000 --duration 86400 \
//     --interval 7 --sample 60 --compose-file docker-compose.yml \
//     --compose-file docker-compose.production.yml --compose-service homepage \
//     --out soak-report.ndjson
//
// Fallback host-process mode:
//   node scripts/soak.mjs --url http://localhost:3000 --pid <server-pid> \
//     --db ./data/homelab.db --out soak-report.ndjson

import Database from "better-sqlite3";
import { appendFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/soak.mjs [options]
  --url URL                    Dashboard base URL (default http://localhost:3000)
  --duration SECONDS           Literal acceptance run: 86400 seconds
  --interval SECONDS           Non-overlapping request cadence (default 7)
  --sample SECONDS             Metrics cadence (default 60)
  --compose-file PATH          Repeat for each Compose file
  --compose-service SERVICE    Sample container RSS and its mounted SQLite DB
  --compose-project-name NAME  Optional Compose project name
  --pid PID --db PATH          Native-process fallback mode
  --out PATH                   NDJSON report (default soak-report.ndjson)`);
  process.exit(0);
}

function parseArgs(argv) {
  const args = new Map();
  const multi = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "1");
      continue;
    }
    i += 1;
    if (key === "compose-file") {
      const values = next.split(",").map((value) => value.trim()).filter(Boolean);
      multi.set(key, (multi.get(key) ?? []).concat(values));
      continue;
    }
    args.set(key, next);
  }
  return { args, multi };
}

function arg(args, name, fallback) {
  return args.get(name) ?? fallback;
}

function parsePositiveNumber(raw, fallback, label) {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function execText(command, argv) {
  try {
    return execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`;
}

function parseSizeToken(raw) {
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?i?b|b)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = {
    B: 1,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    PB: 1000 ** 5,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    PIB: 1024 ** 5,
  };
  return Number.isFinite(value) ? Math.round(value * (multipliers[unit] ?? 1)) : null;
}

function dbBytesFromPath(dbPath) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      // WAL/SHM may not exist yet.
    }
  }
  return total;
}

function readDbMetricsFromFile(dbPath) {
  const row = {
    dbPath,
    dbBytes: dbBytesFromPath(dbPath),
    throughputSamplesRows: null,
    storageSamplesRows: null,
    activityEventsRows: null,
    pageCount: null,
    freelistCount: null,
  };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const count = (table) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() ?? { n: 0 }).n);
    row.throughputSamplesRows = count("throughput_samples");
    row.storageSamplesRows = count("storage_samples");
    row.activityEventsRows = count("activity_events");
    row.pageCount = Number(db.pragma("page_count", { simple: true }));
    row.freelistCount = Number(db.pragma("freelist_count", { simple: true }));
    db.close();
  } catch {
    // Missing DB or pre-migration state: keep byte count and leave logical stats null.
  }
  return row;
}

function composePrefix(composeFiles, composeProjectName) {
  const prefix = ["compose"];
  for (const file of composeFiles) prefix.push("-f", file);
  if (composeProjectName) prefix.push("-p", composeProjectName);
  return prefix;
}

function createComposeSampler(composeFiles, composeProjectName, composeService) {
  if (!composeService) return null;
  const prefix = composePrefix(composeFiles, composeProjectName);

  function composeText(argv) {
    return execText("docker", [...prefix, ...argv]);
  }

  function containerId() {
    const id = composeText(["ps", "-q", composeService]);
    return id || null;
  }

  function containerRssBytes() {
    const id = containerId();
    if (!id) return null;
    const usage = execText("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", id]);
    if (!usage) return null;
    const [rss] = usage.split("/");
    return rss ? parseSizeToken(rss.trim()) : null;
  }

  function dbMetrics() {
    const id = containerId();
    if (!id) {
      return {
        dbPath: null,
        dbBytes: null,
        throughputSamplesRows: null,
        storageSamplesRows: null,
        activityEventsRows: null,
        pageCount: null,
        freelistCount: null,
      };
    }

    const js = `
      const { statSync } = require("node:fs");
      const Database = require("better-sqlite3");
      const dbPath = process.env.HOMELAB_DB_PATH || "/data/homelab.db";
      const row = {
        dbPath,
        dbBytes: 0,
        throughputSamplesRows: null,
        storageSamplesRows: null,
        activityEventsRows: null,
        pageCount: null,
        freelistCount: null,
      };
      for (const suffix of ["", "-wal", "-shm"]) {
        try { row.dbBytes += statSync(dbPath + suffix).size; } catch {}
      }
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const count = (table) =>
          Number((db.prepare("SELECT COUNT(*) AS n FROM " + table).get() || { n: 0 }).n);
        row.throughputSamplesRows = count("throughput_samples");
        row.storageSamplesRows = count("storage_samples");
        row.activityEventsRows = count("activity_events");
        row.pageCount = Number(db.pragma("page_count", { simple: true }));
        row.freelistCount = Number(db.pragma("freelist_count", { simple: true }));
        db.close();
      } catch {}
      process.stdout.write(JSON.stringify(row));
    `;
    const output = composeText(["exec", "-T", composeService, "node", "-e", js]);
    if (!output) {
      return {
        dbPath: null,
        dbBytes: null,
        throughputSamplesRows: null,
        storageSamplesRows: null,
        activityEventsRows: null,
        pageCount: null,
        freelistCount: null,
      };
    }
    try {
      return JSON.parse(output);
    } catch {
      return {
        dbPath: null,
        dbBytes: null,
        throughputSamplesRows: null,
        storageSamplesRows: null,
        activityEventsRows: null,
        pageCount: null,
        freelistCount: null,
      };
    }
  }

  return { containerRssBytes, dbMetrics };
}

function rssKb(pid) {
  if (!pid) return null;
  const output = execText("ps", ["-o", "rss=", "-p", String(pid)]);
  const value = Number(output);
  return Number.isFinite(value) ? value : null;
}

const { args, multi } = parseArgs(process.argv.slice(2));
const url = arg(args, "url", "http://localhost:3000");
const durationS = parsePositiveNumber(arg(args, "duration", "86400"), 86400, "duration");
const intervalS = parsePositiveNumber(arg(args, "interval", "7"), 7, "interval");
const sampleS = parsePositiveNumber(arg(args, "sample", "60"), 60, "sample");
const pid = arg(args, "pid", "");
const dbPath = arg(args, "db", "");
const out = arg(args, "out", "soak-report.ndjson");
const composeService = arg(args, "compose-service", "");
const composeProjectName = arg(args, "compose-project-name", "");
const composeFiles = multi.get("compose-file") ?? [];
const composeSampler = createComposeSampler(composeFiles, composeProjectName, composeService);

const startedAt = Date.now();
const samples = [];
let polls = 0;
let failures = 0;
let lastStatus = 0;

async function pollOnce() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(`${url}/api/dashboard`, { signal: ac.signal, cache: "no-store" });
    lastStatus = res.status;
    await res.arrayBuffer();
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
  const composeDb = dbPath ? null : composeSampler?.dbMetrics() ?? null;
  const fileDb = dbPath ? readDbMetricsFromFile(dbPath) : null;
  const dbMetrics = fileDb ?? composeDb ?? {
    dbPath: null,
    dbBytes: null,
    throughputSamplesRows: null,
    storageSamplesRows: null,
    activityEventsRows: null,
    pageCount: null,
    freelistCount: null,
  };
  const row = {
    t: new Date().toISOString(),
    elapsedS: Math.round((Date.now() - startedAt) / 1000),
    polls,
    failures,
    lastStatus,
    containerRssBytes: composeSampler?.containerRssBytes() ?? null,
    serverRssKb: rssKb(pid),
    dbPath: dbMetrics.dbPath,
    dbBytes: dbMetrics.dbBytes,
    throughputSamplesRows: dbMetrics.throughputSamplesRows,
    storageSamplesRows: dbMetrics.storageSamplesRows,
    activityEventsRows: dbMetrics.activityEventsRows,
    pageCount: dbMetrics.pageCount,
    freelistCount: dbMetrics.freelistCount,
  };
  samples.push(row);
  appendFileSync(out, JSON.stringify(row) + "\n");

  const rss = row.containerRssBytes
    ? formatBytes(row.containerRssBytes)
    : row.serverRssKb
      ? `${(row.serverRssKb / 1024).toFixed(1)}MB`
      : "n/a";
  const db = Number.isFinite(row.dbBytes) ? formatBytes(row.dbBytes) : "n/a";
  console.log(
    `[${row.elapsedS}s] polls=${row.polls} fails=${row.failures} status=${row.lastStatus}` +
      ` rss=${rss} db=${db} rows=${row.throughputSamplesRows ?? "n/a"}/${row.storageSamplesRows ?? "n/a"}/${row.activityEventsRows ?? "n/a"}` +
      ` pages=${row.pageCount ?? "n/a"} free=${row.freelistCount ?? "n/a"}`,
  );
}

function printSummary() {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return;
  const expectedPolls = Math.floor(durationS / intervalS);
  const rowDelta = (key) =>
    Number.isFinite(first[key]) && Number.isFinite(last[key]) ? last[key] - first[key] : null;
  console.log(
    `summary: runtime=${last.elapsedS}s target=${durationS}s` +
      ` polls=${last.polls}/${expectedPolls} failures=${last.failures}` +
      ` rss=${formatBytes(last.containerRssBytes ?? 0)}` +
      ` dbDelta=${Number.isFinite(first.dbBytes) && Number.isFinite(last.dbBytes) ? formatBytes(last.dbBytes - first.dbBytes) : "n/a"}` +
      ` throughputDelta=${rowDelta("throughputSamplesRows") ?? "n/a"}` +
      ` storageDelta=${rowDelta("storageSamplesRows") ?? "n/a"}` +
      ` activityDelta=${rowDelta("activityEventsRows") ?? "n/a"}` +
      ` pageDelta=${rowDelta("pageCount") ?? "n/a"}` +
      ` freelistDelta=${rowDelta("freelistCount") ?? "n/a"}`,
  );
}

console.log(
  `soak: ${url} for ${durationS}s (poll ${intervalS}s, sample ${sampleS}s) → ${out}` +
    (composeService ? ` [compose service: ${composeService}]` : "") +
    (dbPath ? ` [db: ${dbPath}]` : ""),
);

let lastSampleAt = 0;
const endAt = startedAt + durationS * 1000;
sample();

while (Date.now() < endAt) {
  await pollOnce();
  if (Date.now() - lastSampleAt >= sampleS * 1000) {
    sample();
    lastSampleAt = Date.now();
  }
  await new Promise((resolve) => setTimeout(resolve, intervalS * 1000));
}

sample();
printSummary();
console.log(`soak complete: ${polls} polls, ${failures} failures. Report: ${out}`);
