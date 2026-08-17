import importlib.util
import os
import pathlib
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("ZFS_COLLECTOR_TOKEN", "test-token")

MODULE_PATH = pathlib.Path(__file__).with_name("zfs-collector.py")
SPEC = importlib.util.spec_from_file_location("zfs_collector", MODULE_PATH)
zfs_collector = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(zfs_collector)

TiB = 1024 ** 4
# 6-column (PLA-264) form: name,size,alloc,free,frag,health
LIST = "\n".join(
    [
        f"tank\t{20 * TiB}\t{12 * TiB}\t{8 * TiB}\t25\tONLINE",
        f"backup\t{8 * TiB}\t{3 * TiB}\t{5 * TiB}\t5\tDEGRADED",
        f"media\t{4 * TiB}\t{1 * TiB}\t{3 * TiB}\t0\tONLINE",
        f"resilver\t{6 * TiB}\t{2 * TiB}\t{4 * TiB}\t1\tONLINE",
        f"idle\t{2 * TiB}\t{1 * TiB}\t{1 * TiB}\t0\tONLINE",
    ]
)
LEGACY_LIST = f"tank\t{20 * TiB}\t{12 * TiB}\t{8 * TiB}\tONLINE"

ZFS_LIST = "\n".join(
    [
        "tank\t10995116277760\t4398046511104",
        "tank/nested\t123\t456",  # nested datasets must be ignored
        "backup\t2199023255552\t3298534883328",
        "unknown-pool\t1\t2",  # datasets without a pool row must be ignored
    ]
)

STATUS = """
  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 04:12:33 with 0 errors on Sun Aug  3 04:12:33 2025
config:

	NAME        STATE     READ WRITE CKSUM
	tank        ONLINE       0     0     0
	  raidz1-0  ONLINE       0     0     0
	    sda     ONLINE       0     0     0
	    sdb     ONLINE       0     0     0
	    sdc     ONLINE       0     0     0
	    sdd     ONLINE       0     0     0

errors: No known data errors

  pool: backup
 state: DEGRADED
  scan: scrub repaired 0B in 02:00:00 with 2 errors on Sat Aug  2 02:00:00 2025
config:

	NAME         STATE     READ WRITE CKSUM
	backup       DEGRADED     0     0     0
	  mirror-0   ONLINE       0     0     0
	    nvme0n1  ONLINE       0     0     0
	    nvme1n1  ONLINE       0     0     0

errors: 2 data errors, use '-v' for a list

  pool: media
 state: ONLINE
  scan: scrub in progress since Mon Aug 11 09:00:00 2025
errors: No known data errors

  pool: resilver
 state: ONLINE
  scan: resilver in progress since Tue Aug 12 01:02:03 2025
errors: No known data errors

  pool: idle
 state: ONLINE
  scan: none requested
errors: No known data errors
"""


class ZfsCollectorTests(unittest.TestCase):
    def setUp(self):
        self.original_tz = os.environ.get("TZ")
        if hasattr(time, "tzset"):
            os.environ["TZ"] = "UTC"
            time.tzset()

    def tearDown(self):
        if not hasattr(time, "tzset"):
            return
        if self.original_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.original_tz
        time.tzset()

    def test_authorized_requires_matching_bearer_token(self):
        self.assertTrue(zfs_collector._authorized("Bearer test-token"))
        self.assertFalse(zfs_collector._authorized("Bearer wrong"))
        self.assertFalse(zfs_collector._authorized("test-token"))
        self.assertFalse(zfs_collector._authorized(None))

    def test_parse_list_reads_frag_and_defaults_logical_to_null(self):
        pools = zfs_collector._parse_list(LIST)
        self.assertEqual(pools["tank"]["frag"], 25)
        self.assertEqual(pools["backup"]["frag"], 5)
        self.assertIsNone(pools["tank"]["logicalUsed"])
        self.assertIsNone(pools["tank"]["logicalAvail"])

    def test_parse_list_accepts_legacy_five_column_output(self):
        pools = zfs_collector._parse_list(LEGACY_LIST)
        self.assertEqual(pools["tank"]["health"], "ONLINE")
        self.assertEqual(pools["tank"]["size"], 20 * TiB)
        self.assertIsNone(pools["tank"]["frag"])

    def test_parse_zfs_list_merges_root_datasets_only(self):
        pools = zfs_collector._parse_zfs_list(ZFS_LIST, zfs_collector._parse_list(LIST))
        self.assertEqual(pools["tank"]["logicalUsed"], 10995116277760)
        self.assertEqual(pools["tank"]["logicalAvail"], 4398046511104)
        self.assertEqual(pools["backup"]["logicalUsed"], 2199023255552)
        self.assertNotIn("unknown-pool", pools)
        self.assertIsNone(pools["media"]["logicalUsed"])

    def test_apply_status_preserves_scan_state_errors_and_timestamps(self):
        pools = zfs_collector._apply_status(zfs_collector._parse_list(LIST), STATUS)

        self.assertEqual(pools["tank"]["scanState"], "finished")
        self.assertEqual(pools["tank"]["scrubErrors"], 0)
        self.assertEqual(pools["tank"]["lastScrubAt"], 1754194353000)

        self.assertEqual(pools["backup"]["scanState"], "finished")
        self.assertEqual(pools["backup"]["scrubErrors"], 2)
        self.assertEqual(pools["backup"]["lastScrubAt"], 1754100000000)

        self.assertEqual(pools["media"]["scanState"], "scrubbing")
        self.assertEqual(pools["media"]["scrubErrors"], 0)
        self.assertEqual(pools["media"]["lastScrubAt"], 1754902800000)

        self.assertEqual(pools["resilver"]["scanState"], "resilvering")
        self.assertEqual(pools["resilver"]["scrubErrors"], 0)
        self.assertEqual(pools["resilver"]["lastScrubAt"], 1754960523000)

        self.assertEqual(pools["idle"]["scanState"], "none")
        self.assertEqual(pools["idle"]["scrubErrors"], 0)
        self.assertIsNone(pools["idle"]["lastScrubAt"])

    def test_parse_pool_devices_maps_leaf_devices(self):
        devices = zfs_collector._parse_pool_devices(STATUS)
        self.assertEqual(devices["tank"], ["sda", "sdb", "sdc", "sdd"])
        self.assertEqual(devices["backup"], ["nvme0n1", "nvme1n1"])
        self.assertEqual(devices["idle"], [])

    def test_collect_uses_fixed_argv_without_shell(self):
        with patch.object(zfs_collector.subprocess, "run") as run_mock:
            run_mock.side_effect = [
                subprocess.CompletedProcess(
                    ["zpool", "list"], 0, stdout=LIST, stderr="",
                ),
                subprocess.CompletedProcess(
                    ["zpool", "status"], 0, stdout=STATUS, stderr="",
                ),
                subprocess.CompletedProcess(
                    ["zfs", "list"], 0, stdout=ZFS_LIST, stderr="",
                ),
            ]

            payload = zfs_collector._collect_zfs()

        self.assertEqual(
            [pool["name"] for pool in payload["pools"]],
            ["tank", "backup", "media", "resilver", "idle"],
        )
        self.assertEqual(payload["pools"][0]["lastScrubAt"], 1754194353000)
        self.assertEqual(payload["pools"][0]["logicalUsed"], 10995116277760)

        expected_calls = [
            (["zpool", "list", "-Hp", "-o", "name,size,alloc,free,frag,health"],),
            (["zpool", "status"],),
            (["zfs", "list", "-Hp", "-o", "name,used,avail", "-d", "0"],),
        ]
        self.assertEqual([call.args for call in run_mock.call_args_list], expected_calls)
        for call in run_mock.call_args_list:
            self.assertEqual(call.kwargs["capture_output"], True)
            self.assertEqual(call.kwargs["text"], True)
            self.assertEqual(call.kwargs["timeout"], zfs_collector.EXEC_TIMEOUT)
            self.assertEqual(call.kwargs["check"], True)
            self.assertNotIn("shell", call.kwargs)

    def test_collect_zfs_survives_missing_zfs_list(self):
        with patch.object(zfs_collector.subprocess, "run") as run_mock:
            run_mock.side_effect = [
                subprocess.CompletedProcess(["zpool", "list"], 0, stdout=LIST, stderr=""),
                subprocess.CompletedProcess(["zpool", "status"], 0, stdout=STATUS, stderr=""),
                FileNotFoundError("zfs"),
            ]
            payload = zfs_collector._collect_zfs()
        self.assertIsNone(payload["pools"][0]["logicalUsed"])

    def test_gpu_missing_binary_is_not_configured(self):
        with patch.object(
            zfs_collector.subprocess, "run", side_effect=FileNotFoundError("nvidia-smi")
        ):
            self.assertEqual(zfs_collector._fetch_gpu(), {"status": "not-configured"})

    def test_docker_without_proxy_url_is_not_configured(self):
        self.assertEqual(zfs_collector.DOCKER_PROXY_URL, "")
        self.assertEqual(zfs_collector._fetch_docker(), {"status": "not-configured"})

    def test_host_sections_never_serialize_failures_as_zero(self):
        def boom():
            raise OSError("no /proc")

        section = zfs_collector._section(boom)
        self.assertEqual(section, {"status": "unavailable"})


FAKE_CPU = {"total": [1, 2, 3, 4, 5, 6, 7, 8], "cores": [[1, 2, 3, 4, 5, 6, 7, 8]], "load": [0.1, 0.2, 0.3]}
FAKE_MEMORY = {"totalBytes": 100, "availableBytes": 50, "swapTotalBytes": None, "swapUsedBytes": None}
UNAVAILABLE = {"status": "unavailable"}


class BackgroundCacheTests(unittest.TestCase):
    """PLA-272: /v1/host must never block on slow optional providers."""

    def _hanging_fetch(self):
        """A fetch that blocks until the test tears down (simulated hang)."""
        release = threading.Event()
        self.addCleanup(release.set)

        def fetch():
            release.wait()
            return None  # even once released, never publish a value

        return fetch

    def _instant_cache(self, value):
        return zfs_collector._BackgroundCache(60.0, lambda: value, UNAVAILABLE, stale_after=180.0)

    def _collect_host_fast(self, docker_cache, gpu_cache):
        pool_cache = zfs_collector._BackgroundCache(60.0, lambda: {}, {})
        with patch.object(zfs_collector, "DOCKER_CACHE", docker_cache), \
             patch.object(zfs_collector, "GPU_CACHE", gpu_cache), \
             patch.object(zfs_collector, "POOL_DEVICES_CACHE", pool_cache), \
             patch.object(zfs_collector, "_read_cpu", lambda: FAKE_CPU), \
             patch.object(zfs_collector, "_read_memory", lambda: FAKE_MEMORY):
            started = time.monotonic()
            payload = zfs_collector._collect_host()
            elapsed = time.monotonic() - started
        # A hanging provider must not push /v1/host anywhere near the
        # dashboard's ~2 s deadline; the collection itself is procfs-fast.
        self.assertLess(elapsed, 1.0)
        return payload

    def test_hanging_docker_fetch_does_not_delay_host_endpoint(self):
        docker_cache = zfs_collector._BackgroundCache(
            60.0, self._hanging_fetch(), UNAVAILABLE, stale_after=15.0,
        )
        payload = self._collect_host_fast(docker_cache, self._instant_cache({"status": "not-configured"}))
        self.assertEqual(payload["docker"], UNAVAILABLE)
        self.assertEqual(payload["cpu"]["status"], "ok")
        self.assertEqual(payload["memory"]["status"], "ok")

    def test_hanging_gpu_fetch_does_not_delay_host_endpoint(self):
        gpu_cache = zfs_collector._BackgroundCache(
            60.0, self._hanging_fetch(), UNAVAILABLE, stale_after=15.0,
        )
        payload = self._collect_host_fast(self._instant_cache({"status": "not-configured"}), gpu_cache)
        self.assertEqual(payload["gpu"], UNAVAILABLE)
        self.assertEqual(payload["cpu"]["status"], "ok")
        self.assertEqual(payload["memory"]["status"], "ok")

    def test_completed_background_fetch_is_served_from_cache(self):
        calls = []
        value = {"status": "ok", "containers": []}

        def fetch():
            calls.append(1)
            return value

        cache = zfs_collector._BackgroundCache(60.0, fetch, UNAVAILABLE, stale_after=180.0)
        deadline = time.monotonic() + 5.0
        while cache.get() == UNAVAILABLE and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(cache.get(), value)
        # 60 s cadence: repeated get() calls serve the cache, they never
        # trigger a synchronous re-fetch.
        self.assertEqual(len(calls), 1)

    def test_successful_cached_sections_get_their_own_sample_timestamp(self):
        wrapped = zfs_collector._stamp_cached_sample(
            lambda: {"status": "ok", "containers": []},
            wall=lambda: 1234.567,
        )
        payload = wrapped()
        self.assertEqual(payload["sampledAt"], 1_234_567)

    def test_non_ok_cached_sections_are_not_rewritten_with_sample_timestamps(self):
        wrapped = zfs_collector._stamp_cached_sample(
            lambda: {"status": "unavailable"},
            wall=lambda: 1234.567,
        )
        self.assertEqual(wrapped(), {"status": "unavailable"})

    def test_stale_cache_reports_unavailable_instead_of_old_data(self):
        clock = [1000.0]
        cache = zfs_collector._BackgroundCache(
            2.0, self._hanging_fetch(), UNAVAILABLE,
            stale_after=15.0, now=lambda: clock[0],
        )
        with cache.lock:
            cache.value = {"status": "ok", "containers": []}
            cache.at = clock[0]
        self.assertEqual(cache.get()["status"], "ok")
        clock[0] += 14.9  # still inside the stale bound
        self.assertEqual(cache.get()["status"], "ok")
        clock[0] += 0.2  # now past it: old data must not be served as fresh
        self.assertEqual(cache.get(), UNAVAILABLE)

    def test_stale_bound_is_three_intervals_with_a_fifteen_second_floor(self):
        self.assertEqual(zfs_collector._stale_bound(zfs_collector.GPU_CACHE_SECONDS), 15.0)
        self.assertEqual(zfs_collector._stale_bound(zfs_collector.DOCKER_CACHE_SECONDS), 15.0)
        self.assertEqual(zfs_collector._stale_bound(30.0), 90.0)

    def test_docker_refresh_deadline_skips_remaining_stats_calls(self):
        clock = [0.0]
        listing = [
            {"Id": "aaa111", "Names": ["/one"], "State": "running", "Status": "Up 2 hours (healthy)"},
            {"Id": "bbb222", "Names": ["/two"], "State": "running", "Status": "Up 2 hours"},
            {"Id": "ccc333", "Names": ["/three"], "State": "exited", "Status": "Exited (0)"},
        ]
        stats_calls = []

        def fake_docker_get(path):
            if path.startswith("/containers/json"):
                return listing
            stats_calls.append(path)
            # The first stats call alone blows the whole refresh budget.
            clock[0] += zfs_collector.DOCKER_REFRESH_DEADLINE + 1.0
            return {
                "cpu_stats": {"cpu_usage": {"total_usage": 111}, "system_cpu_usage": 222},
                "memory_stats": {"usage": 1000, "stats": {"inactive_file": 100}},
            }

        with patch.object(zfs_collector, "DOCKER_PROXY_URL", "http://proxy"), \
             patch.object(zfs_collector, "_docker_get", fake_docker_get):
            payload = zfs_collector._fetch_docker(now=lambda: clock[0])

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(len(stats_calls), 1)  # second running container skipped
        by_name = {c["name"]: c for c in payload["containers"]}
        self.assertEqual(set(by_name), {"one", "two", "three"})
        self.assertEqual(by_name["one"]["cpuTotalNs"], 111)
        self.assertEqual(by_name["one"]["systemCpuNs"], 222)
        self.assertEqual(by_name["one"]["memoryBytes"], 900)
        self.assertEqual(by_name["one"]["health"], "healthy")
        # List-derived fields survive for the skipped container; stats stay null.
        self.assertEqual(by_name["two"]["state"], "running")
        self.assertIsNone(by_name["two"]["cpuTotalNs"])
        self.assertIsNone(by_name["two"]["systemCpuNs"])
        self.assertIsNone(by_name["two"]["memoryBytes"])
        self.assertIsNone(by_name["three"]["cpuTotalNs"])

    def test_docker_stats_capture_network_and_blkio_counters(self):
        listing = [
            {
                "Id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "Names": ["/one"],
                "State": "running",
                "Status": "Up 1 hour",
                "Labels": {
                    "com.docker.compose.project": "media-stack",
                    "com.docker.compose.service": "jellyfin",
                    "ignored.label": "secret",
                },
                "NetworkSettings": {
                    "Networks": {
                        "media_default": {},
                        "bridge": {},
                    }
                },
            },
            {
                "Id": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
                "Names": ["/two"],
                "State": "running",
                "Status": "Up 1 hour",
                "Labels": {
                    "com.docker.compose.project": "../unsafe",
                    "com.docker.compose.service": "svc with spaces",
                },
                "NetworkSettings": {
                    "Networks": {
                        "bad/name": {},
                        "bridge": {},
                    }
                },
            },
        ]

        def fake_docker_get(path):
            if path.startswith("/containers/json"):
                return listing
            if "0123456789abcdef" in path:
                return {
                    "cpu_stats": {"cpu_usage": {"total_usage": 1}, "system_cpu_usage": 2},
                    "memory_stats": {"usage": 500, "stats": {}},
                    "networks": {
                        "eth0": {"rx_bytes": 1000, "tx_bytes": 400},
                        "eth1": {"rx_bytes": 200, "tx_bytes": 100},
                    },
                    "blkio_stats": {
                        "io_service_bytes_recursive": [
                            {"op": "read", "value": 4096},
                            {"op": "Read", "value": 1024},
                            {"op": "write", "value": 2048},
                            {"op": "total", "value": 999999},
                        ]
                    },
                }
            # Second container: host networking + cgroup v2 without blkio rows —
            # the counters must stay None, never zero.
            return {
                "cpu_stats": {"cpu_usage": {"total_usage": 1}, "system_cpu_usage": 2},
                "memory_stats": {"usage": 500, "stats": {}},
                "blkio_stats": {"io_service_bytes_recursive": None},
            }

        with patch.object(zfs_collector, "DOCKER_PROXY_URL", "http://proxy"), \
             patch.object(zfs_collector, "_docker_get", fake_docker_get):
            payload = zfs_collector._fetch_docker(now=lambda: 0.0)

        by_name = {c["name"]: c for c in payload["containers"]}
        one = by_name["one"]
        self.assertEqual(one["stableId"], "ctr-a8ae6e6ee929abea")
        self.assertEqual(one["composeProject"], "media-stack")
        self.assertEqual(one["composeService"], "jellyfin")
        self.assertEqual(one["networkNames"], ["media_default", "bridge"])
        self.assertEqual(one["netRxBytes"], 1200)  # summed across interfaces
        self.assertEqual(one["netTxBytes"], 500)
        self.assertEqual(one["blockReadBytes"], 5120)  # case-insensitive ops
        self.assertEqual(one["blockWriteBytes"], 2048)  # "total" rows ignored
        two = by_name["two"]
        self.assertEqual(two["stableId"], "ctr-7b9d07f2404b102b")
        self.assertIsNone(two["composeProject"])
        self.assertIsNone(two["composeService"])
        self.assertEqual(two["networkNames"], ["bridge"])
        self.assertIsNone(two["netRxBytes"])
        self.assertIsNone(two["netTxBytes"])
        self.assertIsNone(two["blockReadBytes"])
        self.assertIsNone(two["blockWriteBytes"])


if __name__ == "__main__":
    unittest.main()
