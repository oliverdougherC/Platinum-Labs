"use client";

import { memo, useMemo } from "react";
import {
  arcPath,
  CANVAS_H,
  CANVAS_W,
  CONTAINER_CLUSTER,
  CORE_CENTER,
  CORE_INNER_R,
  CORE_SPOKE_MAX,
  flowPath,
  HALO_R,
  NETWORK_EDGE,
  pointOnCircle,
  SERVICE_NODES,
  spokeAngle,
  storageBodyFor,
  type ServiceId,
} from "@/lib/topology/layout";
import { flowDurationSeconds } from "@/lib/topology/smoothing";
import type { FlowState } from "@/lib/topology/activity";
import { formatBytes, formatCapacityPair, formatRate } from "@/lib/format/bytes";
import { formatPercent, formatRelativeTime } from "@/lib/utils";
import type {
  ConnectorHealth,
  DashboardSnapshot,
  ZfsPool,
} from "@/lib/types";

/**
 * The Living Topology scene (PLA-266/267): ONE full-screen SVG composition.
 *
 *  - compute core: every logical CPU as a fine radial spoke (real core count);
 *  - memory halo: a stippled ring whose filled arc is real memory occupancy;
 *  - storage bodies: capacity arcs on LOGICAL capacity, health/scrub local;
 *  - service orbit: quiet nodes; problems change only their own node;
 *  - flows: real activity animates real paths (see lib/topology/activity).
 *
 * Motion engineering: no requestAnimationFrame loop. Values update at the
 * telemetry cadence (~2s) and CSS transitions/animations interpolate between
 * states; `prefers-reduced-motion` and the frozen screenshot mode disable the
 * marching animations via the `data-motion` attribute set by the app shell.
 */

export type TopologySelection =
  | { kind: "host" }
  | { kind: "pool"; name: string }
  | { kind: "service"; id: ServiceId }
  | { kind: "docker" };

export interface SceneProps {
  snapshot: DashboardSnapshot;
  flows: FlowState[];
  onSelect: (sel: TopologySelection) => void;
}

// --- compute core ------------------------------------------------------------

function ComputeCore({
  snapshot,
  onSelect,
}: {
  snapshot: DashboardSnapshot;
  onSelect: SceneProps["onSelect"];
}) {
  const cpu = snapshot.telemetry.cpu;
  const perCore = cpu.value?.perCore ?? [];
  const total = cpu.value?.totalFraction ?? null;
  const load = cpu.value?.load1 ?? null;
  const dim = cpu.status !== "available";

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label="Host compute detail"
      className="cursor-pointer outline-none focus-visible:opacity-90"
      onClick={() => onSelect({ kind: "host" })}
      onKeyDown={(e) => e.key === "Enter" && onSelect({ kind: "host" })}
    >
      {/* hairline base ring the spokes grow from */}
      <circle
        cx={CORE_CENTER.x}
        cy={CORE_CENTER.y}
        r={CORE_INNER_R}
        className="fill-none stroke-hairline"
        strokeWidth={1}
      />
      {/* one fine spoke per REAL logical CPU — uniform base, load extends it */}
      <g
        className="core-rotate"
        style={{ transformOrigin: `${CORE_CENTER.x}px ${CORE_CENTER.y}px` }}
      >
        {perCore.map((util, i) => {
          const angle = spokeAngle(i, perCore.length);
          const start = pointOnCircle(CORE_CENTER, CORE_INNER_R + 4, angle);
          return (
            <g
              key={i}
              transform={`translate(${start.x} ${start.y}) rotate(${(angle * 180) / Math.PI})`}
            >
              <line
                x1={0}
                y1={0}
                x2={CORE_SPOKE_MAX}
                y2={0}
                className="cpu-spoke stroke-fg"
                strokeWidth={1.5}
                strokeLinecap="round"
                style={{
                  transform: `scaleX(${0.22 + 0.78 * Math.min(util, 1)})`,
                  opacity: 0.26 + 0.54 * Math.min(util, 1),
                }}
              />
            </g>
          );
        })}
      </g>
      {/* unavailable state: no fake spokes, an honest label instead */}
      {dim && (
        <text
          x={CORE_CENTER.x}
          y={CORE_CENTER.y - 14}
          textAnchor="middle"
          className="fill-faint text-[13px]"
        >
          cpu {cpu.status === "not-configured" ? "not collected" : cpu.status}
        </text>
      )}
      <text
        x={CORE_CENTER.x}
        y={CORE_CENTER.y - 16}
        textAnchor="middle"
        className="fill-faint text-[11px] uppercase tracking-[0.18em]"
      >
        {dim ? "" : "p910"}
      </text>
      {!dim && total !== null && (
        <>
          <text
            x={CORE_CENTER.x}
            y={CORE_CENTER.y + 12}
            textAnchor="middle"
            className="tnum fill-fg text-[26px] font-light"
          >
            {formatPercent(total)}
          </text>
          <text
            x={CORE_CENTER.x}
            y={CORE_CENTER.y + 34}
            textAnchor="middle"
            className="tnum fill-faint text-[11px]"
          >
            load {load?.toFixed(2) ?? "—"} · {perCore.length} threads
          </text>
        </>
      )}
    </g>
  );
}

// --- memory halo -------------------------------------------------------------

function MemoryHalo({ snapshot }: { snapshot: DashboardSnapshot }) {
  const mem = snapshot.telemetry.memory;
  const fraction =
    mem.status !== "not-configured" && mem.value
      ? mem.value.usedBytes / mem.value.totalBytes
      : null;
  const swapMeaningful =
    mem.value !== null &&
    mem.value.swapTotalBytes > 0 &&
    mem.value.swapUsedBytes / mem.value.swapTotalBytes > 0.05;
  const labelAnchor = pointOnCircle(CORE_CENTER, HALO_R + 18, -Math.PI / 4);

  return (
    <g aria-hidden>
      {/* full faint ring (capacity) */}
      <circle
        cx={CORE_CENTER.x}
        cy={CORE_CENTER.y}
        r={HALO_R}
        className="halo-stipple fill-none stroke-hairline"
        strokeWidth={1}
        strokeDasharray="1 5"
      />
      {/* used-memory arc */}
      {fraction !== null && (
        <path
          d={arcPath(CORE_CENTER, HALO_R, fraction)}
          className="memory-arc fill-none stroke-fg"
          strokeWidth={2}
          strokeLinecap="round"
          style={{ opacity: mem.status === "stale" ? 0.16 : 0.3 }}
        />
      )}
      {/* swap pressure: a short second arc only when meaningful */}
      {swapMeaningful && mem.value && (
        <path
          d={arcPath(
            CORE_CENTER,
            HALO_R + 7,
            mem.value.swapUsedBytes / mem.value.swapTotalBytes,
          )}
          className="fill-none stroke-warn"
          strokeWidth={1.5}
          style={{ opacity: 0.5 }}
        />
      )}
      <text
        x={labelAnchor.x}
        y={labelAnchor.y}
        className="tnum fill-faint text-[11px]"
      >
        {mem.value
          ? `mem ${formatBytes(mem.value.usedBytes, { system: "binary", digits: 0 })} / ${formatBytes(mem.value.totalBytes, { system: "binary", digits: 0 })}`
          : `mem ${mem.status === "not-configured" ? "not collected" : mem.status}`}
      </text>
    </g>
  );
}

// --- storage bodies ----------------------------------------------------------

function capacityToneClass(fraction: number): string {
  if (fraction >= 0.9) return "stroke-danger";
  if (fraction >= 0.8) return "stroke-warn";
  return "stroke-fg";
}

function StorageBody({
  pool,
  index,
  readBps,
  writeBps,
  onSelect,
}: {
  pool: ZfsPool;
  index: number;
  readBps: number;
  writeBps: number;
  onSelect: SceneProps["onSelect"];
}) {
  const body = storageBodyFor(pool.name, index);
  const { center, r } = body;
  const unhealthy = pool.health !== "ONLINE";
  const io = readBps + writeBps;
  const ioIntensity = io > 250_000 ? Math.min(1, Math.log10(io / 250_000) / 2.5) : 0;
  const writeDominant = writeBps > readBps;
  const capacityLabel = formatCapacityPair(pool.usedBytes, pool.totalBytes);
  const basisNote = pool.capacityBasis === "physical" ? " (physical)" : "";

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${pool.name} storage detail`}
      className="cursor-pointer outline-none"
      onClick={() => onSelect({ kind: "pool", name: pool.name })}
      onKeyDown={(e) => e.key === "Enter" && onSelect({ kind: "pool", name: pool.name })}
    >
      {/* interior: barely-there disc whose weight follows occupancy */}
      <circle
        cx={center.x}
        cy={center.y}
        r={r - 6}
        className="fill-fg"
        style={{ opacity: 0.025 + 0.075 * pool.capacityFraction }}
      />
      {/* body ring — health is LOCAL: only this ring turns red */}
      <circle
        cx={center.x}
        cy={center.y}
        r={r}
        className={`fill-none ${unhealthy ? "stroke-danger" : "stroke-hairline"}`}
        strokeWidth={unhealthy ? 1.5 : 1}
      />
      {/* logical capacity arc */}
      <path
        d={arcPath(center, r, pool.capacityFraction)}
        className={`memory-arc fill-none ${capacityToneClass(pool.capacityFraction)}`}
        strokeWidth={2.5}
        strokeLinecap="round"
        style={{ opacity: 0.5 }}
      />
      {/* live I/O: an inner dashed ring that slowly turns while the pool works */}
      {ioIntensity > 0 && (
        <circle
          cx={center.x}
          cy={center.y}
          r={r * 0.52}
          className={`io-ring fill-none ${writeDominant ? "stroke-ok" : "stroke-accent"}`}
          strokeWidth={1.2}
          strokeDasharray="1.5 13"
          style={{
            opacity: 0.16 + 0.38 * ioIntensity,
            animationDuration: `${20 - 13 * ioIntensity}s`,
            animationDirection: writeDominant ? "normal" : "reverse",
          }}
        />
      )}
      {/* scrub in progress: slow marching outer ring */}
      {(pool.scan === "scrubbing" || pool.scan === "resilvering") && (
        <circle
          cx={center.x}
          cy={center.y}
          r={r + 7}
          className="io-ring fill-none stroke-accent"
          strokeWidth={1}
          strokeDasharray="4 10"
          style={{ opacity: 0.4, animationDuration: "30s" }}
        />
      )}
      <text
        x={center.x}
        y={center.y - 4}
        textAnchor="middle"
        className="fill-fg text-[14px]"
        style={{ opacity: 0.92 }}
      >
        {pool.name}
      </text>
      <text
        x={center.x}
        y={center.y + 14}
        textAnchor="middle"
        className="tnum fill-muted text-[11.5px]"
      >
        {capacityLabel}
        {basisNote}
      </text>
      <text
        x={center.x}
        y={center.y + r + 18}
        textAnchor="middle"
        className={`text-[11px] ${unhealthy ? "fill-danger" : "fill-faint"}`}
      >
        {unhealthy
          ? `${pool.health}${pool.scrubErrors > 0 ? ` · ${pool.scrubErrors} errors` : ""}`
          : pool.scan === "scrubbing"
            ? "scrubbing"
            : pool.lastScrubAt
              ? `scrubbed ${formatRelativeTime(pool.lastScrubAt, Date.now())}`
              : formatPercent(pool.capacityFraction)}
      </text>
    </g>
  );
}

// --- service orbit -----------------------------------------------------------

interface ServiceActivity {
  countLabel: string | null;
  active: boolean;
  detail: string | null;
}

function serviceActivity(snapshot: DashboardSnapshot, id: ServiceId): ServiceActivity {
  if (id === "jellyfin") {
    const sessions = snapshot.jellyfin.sessions;
    if (sessions.length > 0) {
      const transcoding = sessions.some((s) => s.method === "transcode");
      return {
        countLabel: String(sessions.length),
        active: true,
        detail: transcoding ? "transcoding" : "streaming",
      };
    }
    return { countLabel: null, active: false, detail: null };
  }
  if (id === "qbittorrent") {
    const n =
      snapshot.acquisition.rollup.downloading +
      snapshot.acquisition.rollup.failedOrStalled;
    return n > 0
      ? { countLabel: String(n), active: snapshot.acquisition.rollup.downloading > 0, detail: null }
      : { countLabel: null, active: false, detail: null };
  }
  if (id === "sonarr" || id === "radarr") {
    const items = snapshot.acquisition.items.filter(
      (i) => i.source === id && i.state !== "completed",
    );
    return items.length > 0
      ? {
          countLabel: String(items.length),
          active: items.some((i) => i.state === "downloading" || i.state === "importing"),
          detail: null,
        }
      : { countLabel: null, active: false, detail: null };
  }
  return { countLabel: null, active: false, detail: null };
}

function serviceHealth(
  health: ConnectorHealth[],
  id: ServiceId,
): "ok" | "degraded" | "down" | "unconfigured" {
  if (id === "seerr") return "ok"; // interactive surface, not a polled connector
  const h = health.find((x) => x.id === id);
  if (!h || !h.configured) return "unconfigured";
  if (h.status === "healthy") return "ok";
  if (h.status === "degraded") return "degraded";
  return "down";
}

function ServiceOrbit({
  snapshot,
  onSelect,
}: {
  snapshot: DashboardSnapshot;
  onSelect: SceneProps["onSelect"];
}) {
  return (
    <g>
      {SERVICE_NODES.map((node) => {
        const health = serviceHealth(snapshot.health, node.id);
        const activity = serviceActivity(snapshot, node.id);
        const strokeClass =
          health === "down"
            ? "stroke-danger"
            : health === "degraded"
              ? "stroke-warn"
              : activity.active
                ? "stroke-accent"
                : "stroke-border";
        return (
          <g
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={`${node.label} detail`}
            className="cursor-pointer outline-none"
            onClick={() => onSelect({ kind: "service", id: node.id })}
            onKeyDown={(e) => e.key === "Enter" && onSelect({ kind: "service", id: node.id })}
          >
            <circle
              cx={node.center.x}
              cy={node.center.y}
              r={node.r}
              className={`fill-none ${strokeClass}`}
              strokeWidth={health === "ok" && !activity.active ? 1 : 1.5}
              strokeDasharray={health === "unconfigured" ? "3 5" : undefined}
              style={{ opacity: activity.active ? 0.9 : 0.75 }}
            />
            {/* quiet healthy tick; state text only when there is state */}
            {activity.countLabel ? (
              <text
                x={node.center.x}
                y={node.center.y + 4}
                textAnchor="middle"
                className="tnum fill-fg text-[13px]"
              >
                {activity.countLabel}
              </text>
            ) : health === "ok" ? (
              <circle
                cx={node.center.x}
                cy={node.center.y}
                r={2}
                className="fill-ok"
                style={{ opacity: 0.7 }}
              />
            ) : null}
            <text
              x={node.center.x}
              y={node.center.y + node.r + 16}
              textAnchor="middle"
              className="fill-muted text-[12px]"
            >
              {node.label}
            </text>
            {(health !== "ok" || activity.detail) && (
              <text
                x={node.center.x}
                y={node.center.y + node.r + 31}
                textAnchor="middle"
                className={`text-[10.5px] ${
                  health === "down"
                    ? "fill-danger"
                    : health === "degraded"
                      ? "fill-warn"
                      : "fill-faint"
                }`}
              >
                {health === "down"
                  ? "unreachable"
                  : health === "degraded"
                    ? "stale"
                    : health === "unconfigured"
                      ? "not set up"
                      : activity.detail}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// --- secondary docker containers ---------------------------------------------

function ContainerCluster({
  snapshot,
  onSelect,
}: {
  snapshot: DashboardSnapshot;
  onSelect: SceneProps["onSelect"];
}) {
  const docker = snapshot.telemetry.docker;
  if (docker.status === "not-configured") return null;
  const containers = docker.value?.containers ?? [];
  const shown = containers.slice(0, 48);
  const perRow = 12;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label="Docker containers detail"
      className="cursor-pointer outline-none"
      onClick={() => onSelect({ kind: "docker" })}
      onKeyDown={(e) => e.key === "Enter" && onSelect({ kind: "docker" })}
    >
      {shown.map((c, i) => {
        const x = CONTAINER_CLUSTER.x + (i % perRow) * 11;
        const y = CONTAINER_CLUSTER.y + Math.floor(i / perRow) * 11;
        const bad = c.health === "unhealthy" || c.state !== "running";
        return (
          <circle
            key={c.name}
            cx={x}
            cy={y}
            r={1.8}
            className={bad ? "fill-danger" : "fill-fg"}
            style={{ opacity: bad ? 0.9 : 0.3 }}
          >
            <title>{`${c.name} — ${c.state}${c.health ? ` (${c.health})` : ""}`}</title>
          </circle>
        );
      })}
      <text
        x={CONTAINER_CLUSTER.x}
        y={CONTAINER_CLUSTER.y - 14}
        className="fill-faint text-[11px]"
      >
        {docker.value
          ? `${docker.value.running}/${docker.value.total} containers${
              docker.value.unhealthy > 0 ? ` · ${docker.value.unhealthy} unhealthy` : ""
            }`
          : `containers ${docker.status}`}
      </text>
    </g>
  );
}

// --- network edge ------------------------------------------------------------

function NetworkEdge({ snapshot }: { snapshot: DashboardSnapshot }) {
  const net = snapshot.telemetry.network;
  const mid = (NETWORK_EDGE.yTop + NETWORK_EDGE.yBottom) / 2;
  return (
    <g aria-hidden>
      <line
        x1={NETWORK_EDGE.x}
        y1={NETWORK_EDGE.yTop}
        x2={NETWORK_EDGE.x}
        y2={NETWORK_EDGE.yBottom}
        className="stroke-hairline"
        strokeWidth={1}
      />
      <text
        x={NETWORK_EDGE.x - 8}
        y={mid - 30}
        textAnchor="end"
        className="fill-faint text-[11px] uppercase tracking-[0.18em]"
      >
        network
      </text>
      <text x={NETWORK_EDGE.x - 8} y={mid - 6} textAnchor="end" className="tnum fill-muted text-[12px]">
        {net.value ? `↓ ${formatRate(net.value.rxBps)}` : "↓ —"}
      </text>
      <text x={NETWORK_EDGE.x - 8} y={mid + 14} textAnchor="end" className="tnum fill-muted text-[12px]">
        {net.value ? `↑ ${formatRate(net.value.txBps)}` : "↑ —"}
      </text>
      {net.status !== "available" && (
        <text x={NETWORK_EDGE.x - 8} y={mid + 34} textAnchor="end" className="fill-faint text-[10px]">
          {net.status === "not-configured" ? "not collected" : net.status}
        </text>
      )}
    </g>
  );
}

// --- flows -------------------------------------------------------------------

function FlowLayer({ flows }: { flows: FlowState[] }) {
  return (
    <g aria-hidden>
      {flows.map((flow) => {
        const duration = flowDurationSeconds(flow.intensity);
        if (!Number.isFinite(duration)) return null;
        return (
          <path
            key={flow.id}
            d={flowPath(flow.id, flow.pool)}
            className="flow-dash fill-none stroke-accent"
            strokeWidth={1.5}
            style={{
              opacity: 0.14 + 0.42 * flow.intensity,
              animationDuration: `${duration}s`,
            }}
          />
        );
      })}
    </g>
  );
}

// --- scene -------------------------------------------------------------------

export const TopologyScene = memo(function TopologyScene({
  snapshot,
  flows,
  onSelect,
}: SceneProps) {
  const poolIo = useMemo(() => {
    const map = new Map<string, { readBps: number; writeBps: number }>();
    const disk = snapshot.telemetry.disk;
    if (disk.status === "available" && disk.value) {
      for (const p of disk.value.pools) map.set(p.pool, { readBps: p.readBps, writeBps: p.writeBps });
    }
    return map;
  }, [snapshot.telemetry.disk]);

  return (
    <svg
      viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full select-none"
      aria-label="Live homelab topology"
    >
      <FlowLayer flows={flows} />
      <NetworkEdge snapshot={snapshot} />
      <ServiceOrbit snapshot={snapshot} onSelect={onSelect} />
      <ContainerCluster snapshot={snapshot} onSelect={onSelect} />
      <MemoryHalo snapshot={snapshot} />
      <ComputeCore snapshot={snapshot} onSelect={onSelect} />
      {snapshot.zfs.pools.map((pool, i) => {
        const io = poolIo.get(pool.name) ?? { readBps: 0, writeBps: 0 };
        return (
          <StorageBody
            key={pool.name}
            pool={pool}
            index={i}
            readBps={io.readBps}
            writeBps={io.writeBps}
            onSelect={onSelect}
          />
        );
      })}
      {snapshot.zfs.pools.length === 0 && (
        <text
          x={1245}
          y={430}
          textAnchor="middle"
          className="fill-faint text-[12px]"
        >
          storage not configured
        </text>
      )}
    </svg>
  );
});
