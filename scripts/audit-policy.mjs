#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4
};

function parseArgs(argv) {
  const options = {
    scope: "prod",
    reportOnly: false,
    allowlistPath: "docs/dependency-audit-allowlist.json"
  };

  for (const arg of argv) {
    if (arg === "--report-only") {
      options.reportOnly = true;
      continue;
    }

    if (arg.startsWith("--scope=")) {
      options.scope = arg.slice("--scope=".length);
      continue;
    }

    if (arg.startsWith("--allowlist=")) {
      options.allowlistPath = arg.slice("--allowlist=".length);
      continue;
    }
  }

  if (!["prod", "all"].includes(options.scope)) {
    throw new Error(`Unsupported scope "${options.scope}". Use --scope=prod or --scope=all.`);
  }

  return options;
}

function extractAdvisoryId(advisory) {
  const match = advisory.url?.match(/GHSA-[a-z0-9-]+/i);
  if (match) {
    return match[0].toUpperCase();
  }

  if (advisory.source) {
    return `npm:${advisory.source}`;
  }

  return `unknown:${advisory.name}`;
}

function advisoryKey(advisory) {
  return `${advisory.id}|${advisory.package}`;
}

function collectAdvisories(report, minimumSeverity = "high") {
  const findings = new Map();
  const vulnerabilities = report.vulnerabilities ?? {};
  const minimumRank = severityRank[minimumSeverity];

  function visit(name, stack = new Set()) {
    if (stack.has(name)) {
      return;
    }

    const vulnerability = vulnerabilities[name];
    if (!vulnerability) {
      return;
    }

    const nextStack = new Set(stack);
    nextStack.add(name);

    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") {
        visit(via, nextStack);
        continue;
      }

      const severity = via.severity ?? vulnerability.severity ?? "info";
      if ((severityRank[severity] ?? -1) < minimumRank) {
        continue;
      }

      const normalized = {
        id: extractAdvisoryId(via),
        package: via.name,
        severity,
        title: via.title,
        url: via.url ?? null,
        source: via.source ?? null,
        introducedThrough: [name]
      };
      const key = advisoryKey(normalized);
      const existing = findings.get(key);

      if (existing) {
        existing.introducedThrough = Array.from(
          new Set([...existing.introducedThrough, ...normalized.introducedThrough])
        ).sort();
        continue;
      }

      findings.set(key, normalized);
    }
  }

  for (const name of Object.keys(vulnerabilities)) {
    visit(name);
  }

  return Array.from(findings.values()).sort((left, right) => {
    const severityDelta = (severityRank[right.severity] ?? 0) - (severityRank[left.severity] ?? 0);
    if (severityDelta !== 0) {
      return severityDelta;
    }

    return advisoryKey(left).localeCompare(advisoryKey(right));
  });
}

function runAudit(scope) {
  const args = ["audit", "--json"];
  if (scope === "prod") {
    args.push("--omit=dev");
  }

  const result = spawnSync("npm", args, {
    encoding: "utf8",
    cwd: rootDir,
    env: process.env
  });

  if (result.error) {
    throw result.error;
  }

  if (!result.stdout) {
    throw new Error(result.stderr || "npm audit produced no JSON output.");
  }

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `npm audit exited with status ${result.status}.`);
  }

  return JSON.parse(result.stdout);
}

function printFinding(prefix, finding, allowlistEntry) {
  const source = finding.url ?? finding.source ?? "no advisory URL";
  console.log(
    `${prefix} ${finding.id} ${finding.package} (${finding.severity})\n` +
      `  ${finding.title}\n` +
      `  source: ${source}\n` +
      `  introduced through: ${finding.introducedThrough.join(", ")}`
  );

  if (allowlistEntry) {
    console.log(
      `  allowlisted until ${allowlistEntry.expiresOn}: ${allowlistEntry.reason}\n` +
        `  tracking: ${allowlistEntry.tracking}`
    );
  }
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allowlistFile = path.resolve(rootDir, options.allowlistPath);
  const policy = JSON.parse(await readFile(allowlistFile, "utf8"));
  const productionAllowlist = new Map(
    (policy.productionAccepted ?? []).map((entry) => [
      `${String(entry.id).toUpperCase()}|${entry.package}`,
      entry
    ])
  );

  const report = runAudit(options.scope);
  const findings = collectAdvisories(report, "high");
  const reviewed = [];
  const unreviewed = [];

  for (const finding of findings) {
    const entry = productionAllowlist.get(advisoryKey(finding));
    const expired = entry?.expiresOn && entry.expiresOn < new Date().toISOString().slice(0, 10);
    const severityChanged = entry?.severity && entry.severity !== finding.severity;
    if (entry && !expired && !severityChanged) {
      reviewed.push({ finding, entry });
      continue;
    }

    if (entry && (expired || severityChanged)) {
      finding.title += expired
        ? ` [review exception expired ${entry.expiresOn}]`
        : ` [severity changed from ${entry.severity}]`;
    }

    unreviewed.push(finding);
  }

  const label = options.scope === "prod" ? "production runtime dependencies" : "all dependencies";
  const counts = report.metadata?.vulnerabilities ?? {};

  console.log(`Audit scope: ${label}`);
  console.log(
    `npm audit counts: ${counts.info ?? 0} info, ${counts.low ?? 0} low, ${counts.moderate ?? 0} moderate, ${counts.high ?? 0} high, ${counts.critical ?? 0} critical`
  );

  if (reviewed.length === 0 && unreviewed.length === 0) {
    console.log("No high/critical advisories found.");
    return;
  }

  if (reviewed.length > 0) {
    console.log(`Reviewed advisories matched policy (${reviewed.length}):`);
    for (const item of reviewed) {
      printFinding("ACCEPTED", item.finding, item.entry);
    }
  }

  if (unreviewed.length > 0) {
    const headline = options.reportOnly
      ? `Unreviewed high/critical advisories requiring follow-up (${unreviewed.length}):`
      : `Blocking high/critical advisories (${unreviewed.length}):`;
    console.log(headline);
    for (const finding of unreviewed) {
      printFinding(options.reportOnly ? "REVIEW" : "BLOCK", finding);
    }
  }

  if (options.reportOnly) {
    return;
  }

  if (unreviewed.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log("Production audit gate passed: no unreviewed high/critical advisories.");
}

main().catch((error) => {
  console.error(`audit-policy failed: ${error.message}`);
  process.exitCode = 1;
});
