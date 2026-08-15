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
LIST = "\n".join(
    [
        f"tank\t{20 * TiB}\t{12 * TiB}\t{8 * TiB}\tONLINE",
        f"backup\t{8 * TiB}\t{3 * TiB}\t{5 * TiB}\tDEGRADED",
        f"media\t{4 * TiB}\t{1 * TiB}\t{3 * TiB}\tONLINE",
        f"resilver\t{6 * TiB}\t{2 * TiB}\t{4 * TiB}\tONLINE",
        f"idle\t{2 * TiB}\t{1 * TiB}\t{1 * TiB}\tONLINE",
    ]
)

STATUS = """
  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 04:12:33 with 0 errors on Sun Aug  3 04:12:33 2025
errors: No known data errors

  pool: backup
 state: DEGRADED
  scan: scrub repaired 0B in 02:00:00 with 2 errors on Sat Aug  2 02:00:00 2025
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

    def test_collect_uses_fixed_argv_without_shell(self):
        with patch.object(zfs_collector.subprocess, "run") as run_mock:
            run_mock.side_effect = [
                subprocess.CompletedProcess(
                    ["zpool", "list", "-Hp", "-o", "name,size,alloc,free,health"],
                    0,
                    stdout=LIST,
                    stderr="",
                ),
                subprocess.CompletedProcess(
                    ["zpool", "status"],
                    0,
                    stdout=STATUS,
                    stderr="",
                ),
            ]

            payload = zfs_collector._collect()

        self.assertEqual([pool["name"] for pool in payload["pools"]], ["tank", "backup", "media", "resilver", "idle"])
        self.assertEqual(payload["pools"][0]["lastScrubAt"], 1754194353000)

        expected_calls = [
            (["zpool", "list", "-Hp", "-o", "name,size,alloc,free,health"],),
            (["zpool", "status"],),
        ]
        self.assertEqual([call.args for call in run_mock.call_args_list], expected_calls)
        for call in run_mock.call_args_list:
            self.assertEqual(call.kwargs["capture_output"], True)
            self.assertEqual(call.kwargs["text"], True)
            self.assertEqual(call.kwargs["timeout"], zfs_collector.EXEC_TIMEOUT)
            self.assertEqual(call.kwargs["check"], True)
            self.assertNotIn("shell", call.kwargs)


if __name__ == "__main__":
    unittest.main()
