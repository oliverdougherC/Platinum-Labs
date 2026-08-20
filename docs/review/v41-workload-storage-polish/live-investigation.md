# V4.1 sanitized production investigation

Read-only observations from p910 on 2026-08-20. No production configuration,
container, filesystem, pool, transfer, or service was modified. Media paths,
filenames, process arguments, shell history, and secrets were intentionally not
captured.

## Background storage movement

The host and normalized dashboard snapshots were sampled during the ongoing
transfer:

| Signal | Read B/s | Write B/s |
| --- | ---: | ---: |
| `DataStore` | 53,833,435 | 0 |
| `eSATA` | 0 | 59,639,172 |
| `NVME` | 2,047 | 888,388 |
| unassigned devices (`other`) | 2,331,506 | 161,711 |

An independent `zpool iostat -p` sample showed the same unique named-pool
direction at roughly 52.2 MB/s from `DataStore` and 44.6 MB/s into `eSATA`.
There was no competing materially active named reader or writer. A conservative
paired observation can therefore be derived as
`min(DataStore read, eSATA write)` without claiming process-level byte
attribution.

Sanitized Docker telemetry identified the Radarr/.NET workload as the active
application process class, with about 40.4 MB/s of container block reads. The
workload has both pools available, while the destination write is visible at
the host pool layer rather than its cgroup write counter. This is consistent
with a bulk cross-pool library copy. The evidence intentionally stops at the
process class and pool pair; no file path or title was inspected.

The raw host collector already reported named device mappings for `DataStore`,
`NVME`, and `eSATA`. The normalized dashboard snapshot preserved the rates
above. The V4 model did not render the transfer because pool I/O was consumed
only as corroboration for an active Arr `import-copy`; disk-only background
movement had no flow semantic.

## Memory capacity

The raw host collector reported:

- kernel `MemTotal`: `135,025,201,152` bytes (`125.75 GiB`);
- sysfs online memory: 64 blocks at `2,147,483,648` bytes each;
- installed/online physical capacity: `137,438,953,472` bytes (`128 GiB`).

The displayed `135 GB` was therefore the kernel-usable `MemTotal` value formatted
with decimal units and presented as though it described installed hardware.
Installed capacity and usable memory are distinct observations: utilization
continues to use `MemTotal`, while the hardware band now uses the explicit
installed-capacity field when the narrow read-only sysfs source is available.

## Workload inventory

The read-only Docker inventory contained 42 running containers. Compose project
and service labels were present for nearly all workloads and naturally described
stable presentation families including media, Jellyfin services, monitoring,
LLM support, photo management, encoding, the dashboard stack, Minecraft, and
small infrastructure services. These labels are used ahead of name heuristics;
grouping remains presentation-only and makes no claim about networks, routes, or
dependencies.
