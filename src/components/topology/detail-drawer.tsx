"use client";

import { useMemo } from "react";
import { DrawerShell } from "@/components/ui/overlay-shell";
import type { TopologySelection } from "@/components/topology/scene";
import { SERVICE_LABELS } from "@/lib/scene/model";
import { appConfig } from "@/lib/config";
import { formatBytes, formatRate } from "@/lib/format/bytes";
import {
  formatDuration,
  formatPercent,
  formatRelativeTime,
} from "@/lib/utils";
import type {
  AcquisitionItem,
  ActivityEvent,
  DashboardSnapshot,
  ZfsPool,
} from "@/lib/types";

/**
 * Contextual detail drawer (PLA-269). The topology stays artistic; this is
 * where conventional, readable UI lives: exact per-core values, logical vs
 * pool-allocation storage, queue contents, sessions, per-container stats, and the
 * relevant slice of recent activity. Opens as a fixed overlay — the primary
 * composition never reflows.
 */

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-[11.5px] text-faint">{label}</dt>
      <dd
        className={`tnum text-right text-[12.5px] ${
          tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-muted"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-hairline py-4 last:border-b-0">
      <h3 className="mb-2 text-[10.5px] uppercase tracking-[0.18em] text-faint">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ActivityList({ events, now }: { events: ActivityEvent[]; now: number }) {
  if (events.length === 0) {
    return <p className="text-[12px] text-faint">No recent activity.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {events.slice(0, 10).map((ev) => (
        <li key={ev.id} className="flex items-baseline justify-between gap-3">
          <span
            className={`min-w-0 flex-1 truncate text-[12px] ${
              ev.severity === "critical"
                ? "text-danger"
                : ev.severity === "warning"
                  ? "text-warn"
                  : "text-muted"
            }`}
          >
            {ev.message}
          </span>
          <span className="tnum shrink-0 text-[10.5px] text-faint">
            {formatRelativeTime(ev.at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function QueueList({ items, now }: { items: AcquisitionItem[]; now: number }) {
  void now;
  if (items.length === 0) return <p className="text-[12px] text-faint">Queue is empty.</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.id}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
              {item.title}
            </span>
            <span
              className={`shrink-0 text-[10.5px] uppercase tracking-wide ${
                item.state === "failed" || item.state === "stalled"
                  ? "text-warn"
                  : "text-faint"
              }`}
            >
              {item.state}
            </span>
          </div>
          <div className="mt-1 h-px w-full bg-hairline">
            <div
              className={`h-px ${item.state === "stalled" || item.state === "failed" ? "bg-warn" : "bg-accent"}`}
              style={{ width: `${Math.round(item.progress * 100)}%` }}
            />
          </div>
          <p className="tnum mt-0.5 text-[10.5px] text-faint">
            {formatPercent(item.progress)}
            {item.quality ? ` · ${item.quality}` : ""}
            {item.rateBps ? ` · ${formatRate(item.rateBps)}` : ""}
            {item.etaSeconds ? ` · eta ${formatDuration(item.etaSeconds)}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

// --- host --------------------------------------------------------------------

function HostDetail({ snapshot, now }: { snapshot: DashboardSnapshot; now: number }) {
  const t = snapshot.telemetry;
  const cpu = t.cpu.value;
  const mem = t.memory.value;
  const gpu = t.gpu.value;
  const net = t.network.value;
  const disk = t.disk.value;
  const arc = t.arc.value;
  return (
    <>
      <Section title={`CPU ${t.cpu.status !== "available" ? `· ${t.cpu.status}` : ""}`}>
        {cpu ? (
          <>
            <dl>
              <Row label="Total" value={formatPercent(cpu.totalFraction)} />
              <Row
                label="Load 1 / 5 / 15"
                value={[cpu.load1, cpu.load5, cpu.load15]
                  .map((v) => (v === null ? "—" : v.toFixed(2)))
                  .join(" / ")}
              />
            </dl>
            <div className="mt-2 grid grid-cols-8 gap-1" aria-label="Per-core utilization">
              {cpu.perCore.map((v, i) => (
                <div key={i} title={`cpu${i} — ${formatPercent(v)}`}>
                  <div className="flex h-6 w-full items-end bg-surface-2">
                    <div
                      className="w-full bg-accent/70"
                      style={{ height: `${Math.max(4, Math.round(v * 100))}%` }}
                    />
                  </div>
                  <p className="tnum mt-0.5 text-center text-[8.5px] text-faint">{i}</p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-[12px] text-faint">No CPU telemetry ({t.cpu.status}).</p>
        )}
      </Section>
      <Section title="Memory">
        {mem ? (
          <dl>
            <Row
              label="Used / total"
              value={`${formatBytes(mem.usedBytes, { system: "binary" })} / ${formatBytes(mem.totalBytes, { system: "binary" })}`}
            />
            <Row label="Available" value={formatBytes(mem.availableBytes, { system: "binary" })} />
            <Row
              label="Swap"
              value={
                mem.swapTotalBytes === null || mem.swapUsedBytes === null
                  ? "not reported"
                  : `${formatBytes(mem.swapUsedBytes, { system: "binary" })} / ${formatBytes(mem.swapTotalBytes, { system: "binary" })}`
              }
            />
          </dl>
        ) : (
          <p className="text-[12px] text-faint">No memory telemetry ({t.memory.status}).</p>
        )}
      </Section>
      <Section title="GPU">
        {gpu ? (
          <dl>
            <Row label={gpu.name} value={formatPercent(gpu.utilizationFraction)} />
            <Row
              label="VRAM"
              value={`${formatBytes(gpu.vramUsedBytes, { system: "binary" })} / ${formatBytes(gpu.vramTotalBytes, { system: "binary" })}`}
            />
            {gpu.temperatureC !== null && <Row label="Temperature" value={`${gpu.temperatureC} °C`} />}
            {gpu.powerWatts !== null && <Row label="Power" value={`${gpu.powerWatts.toFixed(0)} W`} />}
          </dl>
        ) : (
          <p className="text-[12px] text-faint">
            {t.gpu.status === "not-configured" ? "No GPU provider detected." : `No GPU telemetry (${t.gpu.status}).`}
          </p>
        )}
      </Section>
      <Section title="Network">
        {net ? (
          <dl>
            <Row label="Receive" value={formatRate(net.rxBps)} />
            <Row label="Transmit" value={formatRate(net.txBps)} />
            <Row label="Interfaces" value={net.interfaces.join(", ")} />
          </dl>
        ) : (
          <p className="text-[12px] text-faint">No network telemetry ({t.network.status}).</p>
        )}
      </Section>
      <Section title="Disk I/O">
        {disk ? (
          <dl>
            <Row label="Read" value={formatRate(disk.readBps)} />
            <Row label="Write" value={formatRate(disk.writeBps)} />
            {disk.pools.map((p) => (
              <Row
                key={p.pool}
                label={p.pool}
                value={`r ${formatRate(p.readBps)} · w ${formatRate(p.writeBps)}`}
              />
            ))}
          </dl>
        ) : (
          <p className="text-[12px] text-faint">No disk telemetry ({t.disk.status}).</p>
        )}
      </Section>
      {arc && (
        <Section title="ZFS ARC">
          <dl>
            <Row
              label="Size / target"
              value={`${formatBytes(arc.sizeBytes, { system: "binary" })} / ${arc.targetBytes === null ? "—" : formatBytes(arc.targetBytes, { system: "binary" })}`}
            />
            {arc.hitRatio !== null && <Row label="Hit ratio" value={formatPercent(arc.hitRatio, 1)} />}
          </dl>
        </Section>
      )}
      <Section title="Recent activity">
        <ActivityList
          events={snapshot.activity.filter((e) => e.source === "zfs" || e.source === "qbittorrent")}
          now={now}
        />
      </Section>
    </>
  );
}

// --- storage pool ------------------------------------------------------------

function PoolDetail({
  pool,
  snapshot,
  now,
}: {
  pool: ZfsPool;
  snapshot: DashboardSnapshot;
  now: number;
}) {
  const io =
    snapshot.telemetry.disk.value?.pools.find((p) => p.pool === pool.name) ?? null;
  const history = snapshot.history?.storage ?? [];
  const poolHistory = history
    .filter((row) => typeof row[pool.name] === "number")
    .map((row) => ({ t: row.t, v: row[pool.name] as number }));

  return (
    <>
      <Section title="Logical capacity (files can use)">
        {pool.logical ? (
          <dl>
            <Row label="Used" value={formatBytes(pool.logical.usedBytes)} />
            <Row label="Available" value={formatBytes(pool.logical.availBytes)} />
            <Row label="Total" value={formatBytes(pool.logical.totalBytes)} />
            <Row
              label="Occupancy"
              value={formatPercent(pool.logical.usedFraction, 1)}
              tone={
                pool.logical.usedFraction >= appConfig.thresholds.storageCriticalFraction
                  ? "danger"
                  : pool.logical.usedFraction >= appConfig.thresholds.storageWarnFraction
                    ? "warn"
                    : undefined
              }
            />
          </dl>
        ) : (
          <p className="text-[12px] text-faint">
            The collector predates PLA-264 and reports zpool allocation values only.
          </p>
        )}
      </Section>
      {/* zpool SIZE/ALLOC/FREE describe the pool's allocation space after vdev
          replication (a 2×2 TB mirror shows ~2 TB) — neither usable file space
          nor installed raw device capacity (PLA-274). */}
      <Section title="Pool allocation space (zpool)">
        <dl>
          <Row label="Allocation size" value={`${formatBytes(pool.allocation.sizeBytes)} (${formatBytes(pool.allocation.sizeBytes, { system: "binary" })})`} />
          <Row label="Allocated" value={formatBytes(pool.allocation.allocBytes)} />
          <Row label="Unallocated" value={formatBytes(pool.allocation.freeBytes)} />
          <Row
            label="Allocation used (zpool CAP)"
            value={formatPercent(pool.allocation.capFraction, 1)}
            tone={
              pool.allocation.capFraction >= appConfig.thresholds.storageCriticalFraction
                ? "danger"
                : pool.allocation.capFraction >= appConfig.thresholds.storageWarnFraction
                  ? "warn"
                  : undefined
            }
          />
          {pool.allocation.fragPercent !== null && (
            <Row label="Fragmentation" value={`${pool.allocation.fragPercent}%`} />
          )}
        </dl>
        <p className="mt-1 text-[11px] text-faint">
          Space the pool manages after mirror/RAIDZ topology — not file-usable
          space and not installed disk capacity.
        </p>
      </Section>
      <Section title="Health">
        <dl>
          <Row
            label="Pool state"
            value={pool.health}
            tone={pool.health !== "ONLINE" ? "danger" : undefined}
          />
          <Row
            label="Scrub"
            value={
              pool.scan === "scrubbing"
                ? "in progress"
                : pool.scan === "resilvering"
                  ? "resilvering"
                  : pool.lastScrubAt
                    ? `finished ${formatRelativeTime(pool.lastScrubAt, now)}`
                    : "never"
            }
          />
          <Row
            label="Scrub errors"
            value={String(pool.scrubErrors)}
            tone={pool.scrubErrors > 0 ? "danger" : undefined}
          />
        </dl>
      </Section>
      {io && (
        <Section title="Live I/O">
          <dl>
            <Row label="Read" value={formatRate(io.readBps)} />
            <Row label="Write" value={formatRate(io.writeBps)} />
          </dl>
        </Section>
      )}
      {poolHistory.length >= 3 && (
        <Section title="Used capacity · 30 days">
          <svg width="100%" height="48" viewBox="0 0 320 48" preserveAspectRatio="none" aria-hidden>
            {(() => {
              const t0 = poolHistory[0]!.t;
              const t1 = poolHistory[poolHistory.length - 1]!.t;
              const span = Math.max(1, t1 - t0);
              const peak = Math.max(...poolHistory.map((p) => p.v));
              const min = Math.min(...poolHistory.map((p) => p.v));
              const range = Math.max(1, peak - min);
              const d = poolHistory
                .map(
                  (p, i) =>
                    `${i === 0 ? "M" : "L"} ${(((p.t - t0) / span) * 320).toFixed(1)} ${(44 - ((p.v - min) / range) * 40).toFixed(1)}`,
                )
                .join(" ");
              return <path d={d} className="fill-none stroke-accent" strokeWidth={1.2} />;
            })()}
          </svg>
        </Section>
      )}
      <Section title="SMART">
        <p className="text-[12px] text-faint">
          Per-drive SMART is not collected yet (not configured).
        </p>
      </Section>
    </>
  );
}

// --- service -----------------------------------------------------------------

function ServiceDetail({
  id,
  snapshot,
  now,
}: {
  id: string;
  snapshot: DashboardSnapshot;
  now: number;
}) {
  const health = snapshot.health.find((h) => h.id === id);
  const container = snapshot.telemetry.docker.value?.containers.find(
    (c) => c.name.toLowerCase().includes(id === "seerr" ? "seerr" : id),
  );
  const queue = snapshot.acquisition.items.filter(
    (i) => (id === "qbittorrent" ? true : i.source === id) && i.state !== "completed",
  );
  const events = snapshot.activity.filter((e) => e.source === id);
  const sessions = snapshot.jellyfin.sessions;

  return (
    <>
      {health && (
        <Section title="Connector">
          <dl>
            <Row
              label="Status"
              value={
                !health.configured
                  ? health.configError
                    ? "misconfigured"
                    : "not set up"
                  : health.status
              }
              tone={health.status === "unavailable" && health.configured ? "danger" : undefined}
            />
            {health.lastSuccessAt !== null && (
              <Row label="Last sync" value={formatRelativeTime(health.lastSuccessAt, now)} />
            )}
            {health.configError && <Row label="Config" value={health.configError} tone="warn" />}
            {health.lastError && health.status !== "healthy" && (
              <Row label="Last error" value={health.lastError} tone="warn" />
            )}
            <Row label="Poll interval" value={formatDuration(health.pollIntervalMs / 1000)} />
          </dl>
        </Section>
      )}
      {container && (
        <Section title="Container">
          <dl>
            <Row label="State" value={`${container.state}${container.health ? ` (${container.health})` : ""}`} />
            {container.cpuFraction !== null && (
              <Row label="CPU" value={`${container.cpuFraction.toFixed(2)} cores`} />
            )}
            {container.memoryBytes !== null && (
              <Row label="Memory" value={formatBytes(container.memoryBytes, { system: "binary" })} />
            )}
            <Row
              label="Restarts"
              value={container.restartCount === null ? "—" : String(container.restartCount)}
            />
          </dl>
        </Section>
      )}
      {id === "jellyfin" && (
        <Section title={sessions.length > 0 ? "Now playing" : "Playback"}>
          {sessions.length > 0 ? (
            <ul className="space-y-2.5">
              {sessions.map((s) => (
                <li key={s.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
                      {s.title}
                      {s.subtitle ? ` · ${s.subtitle}` : ""}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-faint">{s.user}</span>
                  </div>
                  <div className="mt-1 h-px w-full bg-hairline">
                    <div className="h-px bg-accent" style={{ width: `${Math.round(s.progress * 100)}%` }} />
                  </div>
                  <p className="tnum mt-0.5 text-[10.5px] text-faint">
                    {formatPercent(s.progress)} · {s.method}
                    {s.resolution ? ` · ${s.resolution}` : ""}
                    {s.rate ? ` · ${formatRate(s.rate.bytesPerSecond)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-faint">
              Idle.
              {snapshot.jellyfin.lastPlaybackAt
                ? ` Last playback ${formatRelativeTime(snapshot.jellyfin.lastPlaybackAt, now)}.`
                : ""}
            </p>
          )}
        </Section>
      )}
      {(id === "sonarr" || id === "radarr" || id === "qbittorrent") && (
        <Section title="Queue">
          <QueueList items={queue} now={now} />
        </Section>
      )}
      <Section title="Recent activity">
        <ActivityList events={events} now={now} />
      </Section>
    </>
  );
}

// --- docker ------------------------------------------------------------------

function DockerDetail({ snapshot }: { snapshot: DashboardSnapshot }) {
  const docker = snapshot.telemetry.docker;
  if (!docker.value) {
    return (
      <Section title="Docker">
        <p className="text-[12px] text-faint">
          {docker.status === "not-configured"
            ? "Docker telemetry is not configured (no socket proxy)."
            : `Docker telemetry ${docker.status}.`}
        </p>
      </Section>
    );
  }
  const containers = [...docker.value.containers].sort(
    (a, b) => (b.cpuFraction ?? -1) - (a.cpuFraction ?? -1),
  );
  return (
    <>
      <Section title="Containers">
        <dl>
          <Row label="Running" value={`${docker.value.running} / ${docker.value.total}`} />
          <Row label="Healthy checks" value={String(docker.value.healthy)} />
          <Row
            label="Unhealthy"
            value={String(docker.value.unhealthy)}
            tone={docker.value.unhealthy > 0 ? "danger" : undefined}
          />
        </dl>
      </Section>
      <Section title="Per-container">
        <ul className="space-y-1">
          {containers.map((c) => (
            <li key={c.name} className="flex items-baseline justify-between gap-3">
              <span
                className={`min-w-0 flex-1 truncate text-[12px] ${
                  c.health === "unhealthy" ||
                  (c.state !== "running" && c.state !== "unknown")
                    ? "text-danger"
                    : c.state === "unknown"
                      ? "text-faint"
                      : "text-muted"
                }`}
              >
                {c.name}
              </span>
              <span className="tnum shrink-0 text-[10.5px] text-faint">
                {c.state !== "running"
                  ? c.state
                  : `${c.cpuFraction !== null ? `${c.cpuFraction.toFixed(2)}c` : "—"} · ${
                      c.memoryBytes !== null ? formatBytes(c.memoryBytes, { system: "binary" }) : "—"
                    }`}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function ContainerDetail({ name, snapshot }: { name: string; snapshot: DashboardSnapshot }) {
  const docker = snapshot.telemetry.docker;
  const container = docker.value?.containers.find((candidate) => candidate.name === name);
  if (!container) {
    return (
      <Section title="Container">
        <p className="text-[12px] text-faint">Container is not present in the latest telemetry.</p>
      </Section>
    );
  }
  return (
    <>
      <Section title="Runtime">
        <dl>
          <Row
            label="State"
            value={container.state}
            tone={
              container.state !== "running" && container.state !== "unknown"
                ? "danger"
                : undefined
            }
          />
          <Row
            label="Health"
            value={container.health ?? "no healthcheck"}
            tone={container.health === "unhealthy" ? "danger" : undefined}
          />
          <Row label="Restarts" value={container.restartCount === null ? "—" : String(container.restartCount)} />
          <Row label="Freshness" value={docker.status === "available" ? "live" : docker.status} />
        </dl>
      </Section>
      <Section title="Resources">
        <dl>
          <Row label="CPU" value={container.cpuFraction === null ? "—" : `${container.cpuFraction.toFixed(2)} cores`} />
          <Row label="Memory" value={container.memoryBytes === null ? "—" : formatBytes(container.memoryBytes, { system: "binary" })} />
        </dl>
      </Section>
      <Section title="Network I/O">
        <dl>
          <Row label="Receive" value={container.netRxBps === null ? "—" : formatRate(container.netRxBps)} />
          <Row label="Transmit" value={container.netTxBps === null ? "—" : formatRate(container.netTxBps)} />
        </dl>
      </Section>
      <Section title="Block I/O">
        <dl>
          <Row label="Read" value={container.blockReadBps === null ? "—" : formatRate(container.blockReadBps)} />
          <Row label="Write" value={container.blockWriteBps === null ? "—" : formatRate(container.blockWriteBps)} />
        </dl>
      </Section>
    </>
  );
}

// --- drawer shell ------------------------------------------------------------

export function DetailDrawer({
  selection,
  snapshot,
  now,
  onClose,
}: {
  selection: TopologySelection | null;
  snapshot: DashboardSnapshot;
  /**
   * Authoritative clock (`referenceNow`): the frozen snapshot clock under the
   * review harness, wall time in production — every relative-time string in
   * the drawer derives from it (V2.1 determinism blocker).
   */
  now: number;
  onClose: () => void;
}) {
  const title = useMemo(() => {
    if (!selection) return "";
    switch (selection.kind) {
      case "host":
        return snapshot.hostLabel?.trim() || "host";
      case "pool":
        return `Pool · ${selection.name}`;
      case "service":
        return SERVICE_LABELS[selection.id] ?? selection.id;
      case "container":
        return `Container · ${selection.name}`;
      case "docker":
        return "Docker";
    }
  }, [selection, snapshot.hostLabel]);

  const pool =
    selection?.kind === "pool"
      ? snapshot.zfs.pools.find((p) => p.name === selection.name) ?? null
      : null;

  return (
    <DrawerShell
      open={selection !== null}
      onClose={onClose}
      title={title || "Detail"}
      closeLabel="Close detail"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {selection?.kind === "host" && <HostDetail snapshot={snapshot} now={now} />}
        {pool && <PoolDetail pool={pool} snapshot={snapshot} now={now} />}
        {selection?.kind === "service" && (
          <ServiceDetail id={selection.id} snapshot={snapshot} now={now} />
        )}
        {selection?.kind === "container" && (
          <ContainerDetail name={selection.name} snapshot={snapshot} />
        )}
        {selection?.kind === "docker" && <DockerDetail snapshot={snapshot} />}
      </div>
    </DrawerShell>
  );
}
