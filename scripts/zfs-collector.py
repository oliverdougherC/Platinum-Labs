#!/usr/bin/env python3
"""Minimal, read-only host/ZFS collector helper (PLA-184 / PLA-206 / PLA-264 /
PLA-265) — Python variant.

Same ZFS contract as scripts/zfs-collector.mjs, for hosts WITHOUT Node. It is
the runtime used by the containerized collector (docker/zfs-collector.Dockerfile):
a tiny, single-purpose sidecar that reads ZFS + host counters and serves
normalized JSON on a private Docker network, so the dashboard container never
needs /dev/zfs, the host zpool binary, elevated capabilities, or host
networking.

ENDPOINTS (all GET, all bearer-token authenticated)
  /            ZFS pools (V1 contract + PLA-264 fields: frag, logicalUsed,
               logicalAvail). Aliased at /v1/zfs.
  /v1/host     Raw host telemetry counters (PLA-265): per-CPU jiffies, meminfo,
               network/disk cumulative byte counters, ZFS ARC, optional GPU via
               nvidia-smi, optional Docker via a read-only socket proxy. RAW
               CUMULATIVE COUNTERS ONLY — the dashboard computes rates from
               successive samples; this process stays stateless per request
               (except the slow-section caches below).

SAFETY PROPERTIES
  - fixed argv only: `zpool list`, `zpool status`, `zfs list`, `nvidia-smi`
    with constant arguments. No shell, no interpolation, no request-controlled
    parameter.
  - read-only: no write/mutating endpoint; Docker access (optional) is GET-only
    against a socket proxy URL supplied by the operator.
  - authenticated: constant-time bearer-token check (ZFS_COLLECTOR_TOKEN).
  - network-restricted: binds ZFS_COLLECTOR_BIND (default 0.0.0.0 inside the
    container's own private network namespace — never published to the LAN).
  - degrades per-section: a section that cannot be collected reports
    status "unavailable" (or "not-configured"); it is NEVER reported as zeros.
  - never blocks on slow providers (PLA-272): GPU, Docker, and pool-device
    topology are refreshed by background daemon threads; /v1/host serves the
    latest completed result (or "unavailable" before the first / after a
    stale one) and stays fast even if nvidia-smi or the Docker proxy hangs.
  - stdlib only: runs anywhere Python 3 exists.

HOST TELEMETRY SOURCES
  /proc/stat, /proc/loadavg, /proc/meminfo, /proc/diskstats are host-global
  even inside a container. Network counters are per-namespace, so the container
  needs host /proc bind-mounted read-only at /host/proc (compose:
  `- /proc:/host/proc:ro`); the collector then reads /host/proc/1/net/dev
  (pid 1 = host init = host network namespace). Without the mount the network
  section is "unavailable" — never zero.

USAGE
    ZFS_COLLECTOR_TOKEN=... [ZFS_COLLECTOR_BIND=0.0.0.0] [ZFS_COLLECTOR_PORT=9797] \
    [HOST_PROC=/host/proc] [HOST_NET_INTERFACES=eno1,ens6f0] \
    [DOCKER_PROXY_URL=http://docker-socket-proxy:2375] \
    python3 scripts/zfs-collector.py
"""

import hmac
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("ZFS_COLLECTOR_TOKEN", "")
BIND = os.environ.get("ZFS_COLLECTOR_BIND", "0.0.0.0")
PORT = int(os.environ.get("ZFS_COLLECTOR_PORT", "9797"))
HOST_PROC = os.environ.get("HOST_PROC", "/host/proc")
NET_INTERFACES = [
    i.strip() for i in os.environ.get("HOST_NET_INTERFACES", "").split(",") if i.strip()
]
DOCKER_PROXY_URL = os.environ.get("DOCKER_PROXY_URL", "").rstrip("/")
EXEC_TIMEOUT = 8
GPU_CACHE_SECONDS = 2.0  # background refresh cadence (between completions)
DOCKER_CACHE_SECONDS = 5.0  # background refresh cadence (between completions)
POOL_DEVICES_CACHE_SECONDS = 30.0  # device topology changes rarely
DOCKER_REFRESH_DEADLINE = 8.0  # total budget for one docker refresh cycle
SECTOR_BYTES = 512  # /proc/diskstats sector counts are always 512-byte units

if not TOKEN:
    print("[zfs-collector] refusing to start: ZFS_COLLECTOR_TOKEN is required", file=sys.stderr)
    sys.exit(1)


def _authorized(header):
    if not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):], TOKEN)


# --- ZFS (V1 contract + PLA-264 logical/frag fields) -------------------------

def _parse_list(stdout):
    pools = {}
    for line in stdout.splitlines():
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) < 5:
            continue
        # 6-column form: name,size,alloc,free,frag,health. 5-column legacy:
        # name,size,alloc,free,health.
        name, size, alloc, free = cols[0], cols[1], cols[2], cols[3]
        frag_col = cols[4] if len(cols) >= 6 else None
        health = cols[5] if len(cols) >= 6 else cols[4]
        try:
            size_n, alloc_n = int(size), int(alloc)
        except ValueError:
            continue
        try:
            free_n = int(free)
        except ValueError:
            free_n = size_n - alloc_n
        frag_n = None
        if frag_col is not None:
            try:
                frag_n = int(frag_col.replace("%", ""))
            except ValueError:
                frag_n = None
        pools[name] = {
            "name": name,
            "size": size_n,
            "alloc": alloc_n,
            "free": free_n,
            "health": health.strip(),
            "frag": frag_n,
            "logicalUsed": None,
            "logicalAvail": None,
            "scanState": "none",
            "lastScrubAt": None,
            "scrubErrors": 0,
        }
    return pools


def _parse_zfs_list(stdout, pools):
    """Merge `zfs list -Hp -o name,used,avail -d 0` root-dataset rows."""
    for line in stdout.splitlines():
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) < 3:
            continue
        name, used, avail = cols[0], cols[1], cols[2]
        if "/" in name or name not in pools:
            continue
        try:
            pools[name]["logicalUsed"] = int(used)
            pools[name]["logicalAvail"] = int(avail)
        except ValueError:
            continue
    return pools


def _parse_scan_timestamp(scan):
    match = re.search(r"(?: on | since )(.+)$", scan)
    if not match:
        return None
    try:
        parsed = datetime.strptime(re.sub(r"\s+", " ", match.group(1).strip()), "%a %b %d %H:%M:%S %Y")
    except ValueError:
        return None
    return int(parsed.timestamp() * 1000)


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
            elif re.search(r"none requested", scan, re.I):
                current["scanState"] = "none"
            elif re.search(r"repaired|scrub|canceled", scan, re.I):
                current["scanState"] = "finished"
            ts = _parse_scan_timestamp(scan)
            if ts is not None:
                current["lastScrubAt"] = ts
            m = re.search(r"with (\d+) errors", scan, re.I)
            if m:
                current["scrubErrors"] = int(m.group(1))
        elif current is not None and line.startswith("errors:"):
            m = re.search(r"(\d+) data errors", line, re.I)
            if m:
                current["scrubErrors"] = int(m.group(1))
    return pools


def _parse_pool_devices(stdout):
    """Map pool name -> leaf device names from `zpool status` config blocks."""
    devices = {}
    current = None
    in_config = False
    for raw in stdout.splitlines():
        line = raw.strip()
        if line.startswith("pool:"):
            current = line[len("pool:"):].strip()
            devices[current] = []
            in_config = False
        elif line.startswith("config:"):
            in_config = True
        elif line.startswith("errors:"):
            in_config = False
        elif in_config and current and line:
            name = line.split()[0]
            # Leaf devices only: skip the pool row, vdev group rows, and headers.
            if name in ("NAME", current) or re.match(r"^(raidz\d?|mirror|spare|log|cache|special|dedup)", name):
                continue
            if re.match(r"^[a-z]+[0-9a-z]*$", name):
                devices[current].append(name)
    return devices


def _collect_zfs():
    listing = subprocess.run(
        ["zpool", "list", "-Hp", "-o", "name,size,alloc,free,frag,health"],
        capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
    )
    status = subprocess.run(
        ["zpool", "status"],
        capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
    )
    pools = _apply_status(_parse_list(listing.stdout), status.stdout)
    try:
        datasets = subprocess.run(
            ["zfs", "list", "-Hp", "-o", "name,used,avail", "-d", "0"],
            capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
        )
        pools = _parse_zfs_list(datasets.stdout, pools)
    except Exception:
        pass  # logical fields stay null; dashboard degrades to physical labels
    return {"pools": list(pools.values())}


# --- host telemetry (PLA-265): raw counters only -----------------------------

def _proc_path(name):
    """Prefer the host-mounted procfs when present (needed for netns files)."""
    hosted = os.path.join(HOST_PROC, name)
    return hosted if os.path.exists(hosted) else os.path.join("/proc", name)


def _read_cpu():
    cores = []
    total = None
    with open(_proc_path("stat")) as f:
        for line in f:
            if not line.startswith("cpu"):
                break
            parts = line.split()
            values = [int(v) for v in parts[1:9]]  # user..steal
            if parts[0] == "cpu":
                total = values
            else:
                cores.append(values)
    with open(_proc_path("loadavg")) as f:
        load = [float(v) for v in f.read().split()[:3]]
    return {"total": total, "cores": cores, "load": load}


def _read_memory():
    fields = {}
    with open(_proc_path("meminfo")) as f:
        for line in f:
            key, _, rest = line.partition(":")
            parts = rest.split()
            if parts:
                fields[key] = int(parts[0]) * 1024  # meminfo reports kB
    total = fields.get("MemTotal")
    avail = fields.get("MemAvailable")
    swap_total = fields.get("SwapTotal")
    swap_free = fields.get("SwapFree")
    if total is None or avail is None:
        raise ValueError("meminfo missing fields")
    return {
        "totalBytes": total,
        "availableBytes": avail,
        "swapTotalBytes": swap_total if swap_total is not None else None,
        "swapUsedBytes": (swap_total - swap_free)
        if swap_total is not None and swap_free is not None
        else None,
    }


PHYSICAL_IF = re.compile(r"^(en|eth|eno|ens|enp|em|wl|bond)")
VIRTUAL_IF = re.compile(r"^(lo|veth|br-|docker|tailscale|virbr|tun|wg)")


def _read_network():
    # Host network counters live in the host netns. Inside a container the
    # only reliable view is host procfs pid 1. Refuse (unavailable) rather
    # than reporting the container's own veth counters as host traffic.
    candidates = [
        os.path.join(HOST_PROC, "1", "net", "dev"),
    ]
    if HOST_PROC == "/proc" or not os.path.exists(HOST_PROC):
        # Running directly on the host (no container): /proc/net/dev is real.
        candidates.append("/proc/net/dev")
    path = next((p for p in candidates if os.path.exists(p)), None)
    if path is None:
        return None
    interfaces = {}
    with open(path) as f:
        for line in f.readlines()[2:]:
            name, _, rest = line.partition(":")
            name = name.strip()
            fields = rest.split()
            if len(fields) < 16:
                continue
            if NET_INTERFACES:
                if name not in NET_INTERFACES:
                    continue
            elif not PHYSICAL_IF.match(name) or VIRTUAL_IF.match(name):
                continue
            interfaces[name] = {"rxBytes": int(fields[0]), "txBytes": int(fields[8])}
    if not interfaces:
        return None
    return {"interfaces": interfaces}


WHOLE_DISK = re.compile(r"^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+)$")


def _read_disks(pool_devices):
    devices = {}
    with open(_proc_path("diskstats")) as f:
        for line in f:
            parts = line.split()
            if len(parts) < 14:
                continue
            name = parts[2]
            if not WHOLE_DISK.match(name):
                continue
            devices[name] = {
                "readBytes": int(parts[5]) * SECTOR_BYTES,
                "writeBytes": int(parts[9]) * SECTOR_BYTES,
            }
    return {"devices": devices, "poolDevices": pool_devices}


def _read_arc():
    path = _proc_path("spl/kstat/zfs/arcstats")
    if not os.path.exists(path):
        return None
    wanted = {"size": None, "c": None, "hits": None, "misses": None}
    with open(path) as f:
        for line in f:
            parts = line.split()
            if len(parts) == 3 and parts[0] in wanted:
                wanted[parts[0]] = int(parts[2])
    if wanted["size"] is None:
        return None
    return {
        "sizeBytes": wanted["size"],
        "targetBytes": wanted["c"],
        "hits": wanted["hits"],
        "misses": wanted["misses"],
    }


def _stale_bound(interval):
    """Freshness horizon for a background cache: 3x its cadence, min 15 s."""
    return max(3.0 * interval, 15.0)


class _BackgroundCache:
    """Serve slow-provider data without ever blocking the request path.

    `get()` never fetches: it returns the last completed fetch result
    immediately, or `placeholder` before the first fetch completes. A single
    daemon thread per cache (started lazily on the first `get()`) refreshes
    the value, sleeping `interval` seconds between refresh COMPLETIONS, so a
    slow or hanging provider (Docker proxy, nvidia-smi, zpool) can never
    delay `/v1/host` or stack up concurrent work (PLA-272).

    A fetch that raises or returns None leaves the last known value in place.
    Freshness: when `stale_after` is set and the last completed fetch is
    older than it, `get()` returns `placeholder` instead of the old value —
    stale telemetry is never served as fresh, and never as fabricated zeros.
    With `stale_after=None` the last known value is kept indefinitely (only
    used for non-telemetry data that changes rarely, e.g. pool device
    topology).
    """

    def __init__(self, interval, fetch, placeholder, stale_after=None, now=time.monotonic):
        self.interval = interval
        self.fetch = fetch
        self.placeholder = placeholder
        self.stale_after = stale_after
        self.now = now
        self.lock = threading.Lock()
        self.value = None
        self.at = None  # monotonic time of the last COMPLETED fetch
        self._started = False

    def get(self):
        self._ensure_thread()
        with self.lock:
            if self.at is None:
                return self.placeholder
            if self.stale_after is not None and self.now() - self.at >= self.stale_after:
                return self.placeholder
            return self.value

    def _ensure_thread(self):
        with self.lock:
            if self._started:
                return
            self._started = True
        threading.Thread(target=self._run, daemon=True, name="collector-cache").start()

    def _run(self):
        while True:
            try:
                value = self.fetch()
            except Exception:
                value = None  # keep last known value; staleness handles decay
            if value is not None:
                with self.lock:
                    self.value = value
                    self.at = self.now()
            time.sleep(self.interval)


def _fetch_gpu():
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
        )
    except FileNotFoundError:
        return {"status": "not-configured"}
    except Exception:
        return {"status": "unavailable"}
    line = out.stdout.strip().splitlines()
    if not line:
        return {"status": "unavailable"}
    parts = [p.strip() for p in line[0].split(",")]
    if len(parts) < 4:
        return {"status": "unavailable"}

    def _num(v):
        try:
            return float(v)
        except ValueError:
            return None

    util = _num(parts[1])
    vram_used = _num(parts[2])
    vram_total = _num(parts[3])
    if util is None or vram_used is None or vram_total is None:
        return {"status": "unavailable"}
    return {
        "status": "ok",
        "name": parts[0],
        "utilizationPercent": util,
        "vramUsedBytes": int(vram_used * 1024 * 1024),
        "vramTotalBytes": int(vram_total * 1024 * 1024),
        "temperatureC": _num(parts[4]) if len(parts) > 4 else None,
        "powerWatts": _num(parts[5]) if len(parts) > 5 else None,
    }


def _docker_get(path):
    req = urllib.request.Request(DOCKER_PROXY_URL + path, method="GET")
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read())


def _fetch_docker(now=time.monotonic):
    if not DOCKER_PROXY_URL:
        return {"status": "not-configured"}
    started = now()
    try:
        listing = _docker_get("/containers/json?all=true")
    except Exception:
        return {"status": "unavailable"}
    containers = []
    for entry in listing:
        names = entry.get("Names") or []
        name = names[0].lstrip("/") if names else entry.get("Id", "")[:12]
        state = entry.get("State", "")
        status_text = entry.get("Status", "")
        health = None
        if "(healthy)" in status_text:
            health = "healthy"
        elif "(unhealthy)" in status_text:
            health = "unhealthy"
        elif "(health: starting)" in status_text:
            health = "starting"
        container = {
            "name": name,
            "state": state,
            "health": health,
            "restartCount": None,
            "cpuTotalNs": None,
            "systemCpuNs": None,
            "memoryBytes": None,
            # Cumulative I/O counters from the same one-shot stats call; the
            # dashboard normalizes successive samples into rates. None when
            # the runtime does not expose them (never fabricated zeros).
            "netRxBytes": None,
            "netTxBytes": None,
            "blockReadBytes": None,
            "blockWriteBytes": None,
        }
        # Bound one refresh cycle: once the total budget is spent, skip the
        # remaining per-container stats calls (their fields stay null) so a
        # slow proxy can't stretch a refresh indefinitely. List-derived
        # fields are still returned for every container.
        if state == "running" and now() - started < DOCKER_REFRESH_DEADLINE:
            try:
                stats = _docker_get(
                    f"/containers/{entry['Id']}/stats?stream=false&one-shot=true"
                )
                cpu = stats.get("cpu_stats", {})
                container["cpuTotalNs"] = cpu.get("cpu_usage", {}).get("total_usage")
                container["systemCpuNs"] = cpu.get("system_cpu_usage")
                mem = stats.get("memory_stats", {})
                usage = mem.get("usage")
                inactive = (mem.get("stats") or {}).get("inactive_file") or 0
                if usage is not None:
                    container["memoryBytes"] = max(0, usage - inactive)
                # Per-container network counters: sum across interfaces. The
                # key is absent for host/none network modes — leave None.
                networks = stats.get("networks")
                if isinstance(networks, dict) and networks:
                    rx = tx = 0
                    valid = True
                    for iface in networks.values():
                        if not isinstance(iface, dict):
                            valid = False
                            break
                        rx += iface.get("rx_bytes") or 0
                        tx += iface.get("tx_bytes") or 0
                    if valid:
                        container["netRxBytes"] = rx
                        container["netTxBytes"] = tx
                # Block I/O: io_service_bytes_recursive rows (cgroup v1 and
                # v2 both report them here when available; None otherwise).
                blkio = (stats.get("blkio_stats") or {}).get(
                    "io_service_bytes_recursive"
                )
                if isinstance(blkio, list) and blkio:
                    read = write = 0
                    saw = False
                    for row in blkio:
                        if not isinstance(row, dict):
                            continue
                        op = str(row.get("op", "")).lower()
                        value = row.get("value")
                        if not isinstance(value, (int, float)):
                            continue
                        if op == "read":
                            read += int(value)
                            saw = True
                        elif op == "write":
                            write += int(value)
                            saw = True
                    if saw:
                        container["blockReadBytes"] = read
                        container["blockWriteBytes"] = write
            except Exception:
                pass  # keep list-derived fields; stats stay null
        containers.append(container)
    return {"status": "ok", "containers": containers}


def _fetch_pool_devices():
    """pool -> leaf devices via `zpool status` (fixed argv, read-only)."""
    try:
        status = subprocess.run(
            ["zpool", "status"],
            capture_output=True, text=True, timeout=EXEC_TIMEOUT, check=True,
        )
    except Exception:
        return None  # keep the last known mapping (or the empty placeholder)
    return _parse_pool_devices(status.stdout)


GPU_CACHE = _BackgroundCache(
    GPU_CACHE_SECONDS, _fetch_gpu, {"status": "unavailable"},
    stale_after=_stale_bound(GPU_CACHE_SECONDS),
)
DOCKER_CACHE = _BackgroundCache(
    DOCKER_CACHE_SECONDS, _fetch_docker, {"status": "unavailable"},
    stale_after=_stale_bound(DOCKER_CACHE_SECONDS),
)
# Device topology is not telemetry (it only groups per-pool I/O), so the last
# known mapping is kept on failure; `{}` is the harmless empty fallback.
POOL_DEVICES_CACHE = _BackgroundCache(
    POOL_DEVICES_CACHE_SECONDS, _fetch_pool_devices, {},
)


def _section(fn, *args):
    """Run one host section; unavailable on ANY failure — never fake zeros."""
    try:
        value = fn(*args)
    except Exception:
        return {"status": "unavailable"}
    if value is None:
        return {"status": "unavailable"}
    return {"status": "ok", **value}


def _collect_host():
    # Never run slow providers inline: everything below either reads procfs
    # (fast) or serves a background cache, so /v1/host stays within the
    # dashboard's ~2 s polling deadline regardless of Docker/GPU/zpool health.
    pool_devices = POOL_DEVICES_CACHE.get()
    return {
        "sampledAt": int(time.time() * 1000),
        "cpu": _section(_read_cpu),
        "memory": _section(_read_memory),
        "network": _section(_read_network),
        "disk": _section(_read_disks, pool_devices),
        "arc": _section(_read_arc),
        "gpu": GPU_CACHE.get(),
        "docker": DOCKER_CACHE.get(),
    }


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
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path in ("/", "/v1/zfs"):
                return self._send(200, _collect_zfs())
            if path == "/v1/host":
                return self._send(200, _collect_host())
            return self._send(404, {"error": "not found"})
        except Exception:
            # Never echo argv/paths from the underlying error.
            self._send(503, {"error": "collector unavailable"})

    def log_message(self, *args):
        pass  # quiet: no request logging (avoids noise / any path leakage)


if __name__ == "__main__":
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"[zfs-collector] listening on {BIND}:{PORT} (read-only, token-auth)", flush=True)
    server.serve_forever()
