# Containerized read-only ZFS collector (PLA-184 / PLA-206).
#
# A tiny, single-purpose sidecar for hosts where the dashboard runs in a
# container and cannot (or should not) reach a host-side helper. It reads ZFS via
# the host kernel module through `--device=/dev/zfs` and serves normalized pool
# JSON on the dashboard's PRIVATE Docker network.
#
# Deliberately compartmentalized — deploy it with:
#   devices:      ["/dev/zfs:/dev/zfs"]   # read-only ZFS ioctls only
#   cap_drop:     [ALL]
#   security_opt: ["no-new-privileges:true"]
#   read_only:    true
#   networks:     [<dashboard-private-net>]   # never published to the LAN
# No Docker socket, no privileged mode, no host filesystem mounts, no host
# networking. The container only runs the two fixed read-only `zpool` commands.
FROM ubuntu:24.04

# `zpool`/`zfs` userspace + a Python 3 runtime (no pip deps — stdlib only).
RUN apt-get update \
    && apt-get install -y --no-install-recommends zfsutils-linux python3-minimal ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/zfs-collector.py /usr/local/bin/zfs-collector.py

# Runs unprivileged; /dev/zfs is accessed via the (world-readable) device node,
# not via elevated capabilities.
USER nobody
ENV ZFS_COLLECTOR_BIND=0.0.0.0 \
    ZFS_COLLECTOR_PORT=9797
EXPOSE 9797
CMD ["python3", "/usr/local/bin/zfs-collector.py"]
