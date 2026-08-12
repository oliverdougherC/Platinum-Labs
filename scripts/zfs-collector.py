#!/usr/bin/env python3
"""Minimal, read-only ZFS collector helper (PLA-184 / PLA-206) — Python variant.

Same contract as scripts/zfs-collector.mjs, for hosts WITHOUT Node. It is the
runtime used by the containerized collector (docker/zfs-collector.Dockerfile):
a tiny, single-purpose sidecar that reads ZFS and serves normalized pool JSON on
a private Docker network, so the dashboard container never needs /dev/zfs, the
host zpool binary, elevated capabilities, or host networking.

SAFETY PROPERTIES
  - fixed argv only: `zpool list -Hp -o name,size,alloc,free,health` and
    `zpool status`. No shell, no interpolation, no request-controlled parameter.
  - read-only: no write/mutating endpoint.
  - authenticated: constant-time bearer-token check (ZFS_COLLECTOR_TOKEN).
  - network-restricted: binds ZFS_COLLECTOR_BIND (default 0.0.0.0 inside the
    container's own private network namespace — never published to the LAN).
  - stdlib only: runs anywhere Python 3 exists.

USAGE
    ZFS_COLLECTOR_TOKEN=... [ZFS_COLLECTOR_BIND=0.0.0.0] [ZFS_COLLECTOR_PORT=9797] \
    python3 scripts/zfs-collector.py
"""

import hmac
import json
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("ZFS_COLLECTOR_TOKEN", "")
BIND = os.environ.get("ZFS_COLLECTOR_BIND", "0.0.0.0")
PORT = int(os.environ.get("ZFS_COLLECTOR_PORT", "9797"))
EXEC_TIMEOUT = 8

if not TOKEN:
    print("[zfs-collector] refusing to start: ZFS_COLLECTOR_TOKEN is required", file=sys.stderr)
    sys.exit(1)


def _authorized(header):
    if not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):], TOKEN)


def _parse_list(stdout):
    pools = {}
    for line in stdout.splitlines():
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) < 5:
            continue
        name, size, alloc, free, health = cols[:5]
        try:
            size_n, alloc_n = int(size), int(alloc)
        except ValueError:
            continue
        try:
            free_n = int(free)
        except ValueError:
            free_n = size_n - alloc_n
        pools[name] = {
            "name": name,
            "size": size_n,
            "alloc": alloc_n,
            "free": free_n,
            "health": health.strip(),
            "scanState": "none",
            "lastScrubAt": None,
            "scrubErrors": 0,
        }
    return pools


def _apply_status(pools, stdout):
    current = None
    for raw in stdout.splitlines():
        line = raw.strip()
        if line.startswith("pool:"):
            current = pools.get(line[len("pool:"):].strip())
        elif current is not None and line.startswith("scan:"):
            scan = line[len("scan:"):].strip()
            if re.search(r"resilver in progress", scan, re.I):
                current["scanState"] = "resilvering"
            elif re.search(r"in progress", scan, re.I):
                current["scanState"] = "scrubbing"
            elif re.search(r"repaired|scrub|canceled", scan, re.I):
                current["scanState"] = "finished"
            m = re.search(r"with (\d+) errors", scan, re.I)
            if m:
                current["scrubErrors"] = int(m.group(1))
        elif current is not None and line.startswith("errors:"):
            m = re.search(r"(\d+) data errors", line, re.I)
            if m:
                current["scrubErrors"] = int(m.group(1))
    return pools


def _collect():
    listing = subprocess.run(
        ["zpool", "list", "-Hp", "-o", "name,size,alloc,free,health"],
        capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
    )
    status = subprocess.run(
        ["zpool", "status"],
        capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
    )
    pools = _apply_status(_parse_list(listing.stdout), status.stdout)
    return {"pools": list(pools.values())}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        if not _authorized(self.headers.get("Authorization")):
            return self._send(401, {"error": "unauthorized"})
        try:
            self._send(200, _collect())
        except Exception:
            # Never echo argv/paths from the underlying error.
            self._send(503, {"error": "zpool unavailable"})

    def log_message(self, *args):
        pass  # quiet: no request logging (avoids noise / any path leakage)


if __name__ == "__main__":
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"[zfs-collector] listening on {BIND}:{PORT} (read-only, token-auth)", flush=True)
    server.serve_forever()
