import importlib.util
import os
import pathlib
import subprocess
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


if __name__ == "__main__":
    unittest.main()
