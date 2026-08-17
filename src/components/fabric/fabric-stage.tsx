"use client";

import { useEffect, useMemo, useRef } from "react";
import { FABRIC_VIEWBOX } from "@/lib/fabric/layout";
import type {
  FabricModel,
  FabricNode,
  FabricNodeStatus,
  FabricRelationship,
  FabricResourceView,
} from "@/lib/fabric/model";

export interface FabricSelection {
  kind: "node" | "relationship";
  id: string;
}

const statusGlyph: Record<Exclude<FabricNodeStatus, "healthy">, string> = {
  degraded: "!",
  unavailable: "×",
  stale: "S",
  "not-configured": "–",
  unknown: "?",
};

const statusStroke = (status: FabricNodeStatus): string => {
  if (status === "degraded") return "rgb(var(--color-warn))";
  if (status === "unavailable") return "rgb(var(--color-danger))";
  if (status === "stale" || status === "unknown") return "rgb(var(--color-faint))";
  if (status === "not-configured") return "rgb(var(--color-hairline))";
  return "rgb(var(--color-border))";
};

function useFlowScheduler(root: React.RefObject<SVGSVGElement | null>, enabled: boolean) {
  useEffect(() => {
    const svg = root.current;
    if (!svg || !enabled) return;
    let frame = 0;
    let previous = performance.now();
    let phase = 0;
    let running = !document.hidden;

    const tick = (now: number) => {
      const delta = Math.min(50, Math.max(0, now - previous));
      previous = now;
      phase = (phase + delta / 32) % 120;
      svg.querySelectorAll<SVGPathElement>("[data-fabric-flow-motion='true']").forEach((path) => {
        const reverse = path.dataset.direction === "reverse";
        path.style.strokeDashoffset = String(reverse ? phase : -phase);
      });
      if (running) frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      running = !document.hidden;
      cancelAnimationFrame(frame);
      if (running) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    if (running) frame = requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, root]);
}

function aggregateSegments(segments: number[], limit = 64): { values: number[]; sourceCount: number; aggregated: boolean } {
  if (segments.length <= limit) return { values: segments, sourceCount: segments.length, aggregated: false };
  const bucketSize = Math.ceil(segments.length / limit);
  const values: number[] = [];
  for (let index = 0; index < segments.length; index += bucketSize) {
    const bucket = segments.slice(index, index + bucketSize);
    values.push(bucket.reduce((sum, value) => sum + value, 0) / bucket.length);
  }
  return { values, sourceCount: segments.length, aggregated: true };
}

function ResourceNode({ node, view, selectedNodeId }: { node: FabricNode; view: FabricResourceView | undefined; selectedNodeId: string | null }) {
  const { bounds } = node;
  const segments = view?.segments ?? [];
  const contribution = selectedNodeId ? view?.contributors?.find((item) => item.nodeId === selectedNodeId) : undefined;
  const topology = aggregateSegments(segments);
  const shown = topology.values;
  const columns = node.id === "resource:cpu" ? Math.min(32, Math.max(1, shown.length)) : 1;
  const rows = Math.max(1, Math.ceil(shown.length / columns));
  const cellGap = 2;
  const cellWidth = (bounds.width - 28 - cellGap * (columns - 1)) / columns;
  const cellHeight = (18 - cellGap * (rows - 1)) / rows;
  return (
    <g>
      <text x={bounds.x + 14} y={bounds.y + 20} className="fabric-eyebrow">{node.eyebrow}</text>
      <text x={bounds.x + 14} y={bounds.y + 43} className="fabric-title">{node.label}</text>
      {node.metrics.slice(0, 2).map((metric, index) => (
        <text key={metric.label} x={bounds.x + 14 + index * 110} y={bounds.y + 64} className="fabric-metric">
          <tspan>{metric.value}</tspan>
          <tspan className="fabric-metric-label" dx="5">{metric.label}</tspan>
        </text>
      ))}
      {contribution ? (
        <text
          x={bounds.x + bounds.width - 12}
          y={bounds.y + 64}
          textAnchor="end"
          className="fabric-contribution-label"
          data-resource-contribution={contribution.nodeId}
          data-resource-coverage={contribution.coverage}
        >
          {contribution.value === null
            ? "SELECTED UNKNOWN"
            : `${view?.id === "cpu" ? `${contribution.value.toFixed(2)}C` : formatCompactBytes(contribution.value)} SELECTED${contribution.coverage === "partial" ? " ≈" : ""}`}
        </text>
      ) : null}
      {node.id === "resource:cpu" ? <g
        data-cpu-topology={topology.aggregated ? "aggregated" : "complete"}
        data-cpu-source-count={topology.sourceCount}
        data-cpu-rendered-count={shown.length}
        aria-label={topology.aggregated ? `${topology.sourceCount} logical CPUs aggregated into ${shown.length} labeled groups` : `${topology.sourceCount} logical CPUs shown individually`}
      >
        {topology.aggregated ? (
          <text x={bounds.x + bounds.width - 12} y={bounds.y + 73} textAnchor="end" className="fabric-topology-label">
            {topology.sourceCount} LOGICAL → {shown.length} GROUPS
          </text>
        ) : null}
        {shown.map((value, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        const x = bounds.x + 14 + col * (cellWidth + cellGap);
        const y = bounds.y + 78 + row * (cellHeight + cellGap);
        return (
          <g key={index}>
            <rect x={x} y={y} width={cellWidth} height={cellHeight} rx="1" className="fabric-gauge-track" />
            <rect x={x} y={y + cellHeight * (1 - Math.min(1, value))} width={cellWidth} height={cellHeight * Math.min(1, value)} rx="1" className="fabric-gauge-fill" />
          </g>
        );
      })}
        {contribution?.fraction !== null && contribution?.fraction !== undefined ? (
          <rect
            x={bounds.x + 14}
            y={bounds.y + bounds.height - 4}
            width={(bounds.width - 28) * Math.max(0, Math.min(1, contribution.fraction))}
            height="2"
            rx="1"
            className="fabric-contribution-fill"
          />
        ) : null}
      </g> : (
        <>
          <rect x={bounds.x + 14} y={bounds.y + bounds.height - 20} width={bounds.width - 28} height="6" rx="3" className="fabric-gauge-track" />
          {view?.fraction !== null && view?.fraction !== undefined ? (
            <rect x={bounds.x + 14} y={bounds.y + bounds.height - 20} width={(bounds.width - 28) * Math.max(0, Math.min(1, view.fraction))} height="6" rx="3" className="fabric-gauge-fill" />
          ) : null}
          {contribution?.fraction !== null && contribution?.fraction !== undefined ? (
            <rect
              x={bounds.x + 14}
              y={bounds.y + bounds.height - 20}
              width={(bounds.width - 28) * Math.max(0, Math.min(1, contribution.fraction))}
              height="6"
              rx="3"
              className="fabric-contribution-fill"
            />
          ) : null}
        </>
      )}
    </g>
  );
}

function WorkloadNode({ node }: { node: FabricNode }) {
  const { bounds } = node;
  return (
    <g>
      <text x={bounds.x + 13} y={bounds.y + 16} className="fabric-eyebrow">{node.eyebrow}</text>
      <text x={bounds.x + 13} y={bounds.y + 36} className="fabric-service-title">{node.label}</text>
      {node.metrics.slice(0, 2).map((metric, index) => (
        <text key={metric.label} x={bounds.x + 13 + index * 82} y={bounds.y + 53} className="fabric-metric">
          {metric.value}<tspan className="fabric-metric-label" dx="4">{metric.label}</tspan>
        </text>
      ))}
    </g>
  );
}

function StorageNode({ node }: { node: FabricNode }) {
  const { bounds } = node;
  const used = node.metrics.find((metric) => metric.label === "used")?.value;
  const fraction = used ? Number.parseInt(used, 10) / 100 : 0;
  return (
    <g>
      <text x={bounds.x + 14} y={bounds.y + 20} className="fabric-eyebrow">{node.eyebrow}</text>
      <text x={bounds.x + 14} y={bounds.y + 40} className="fabric-service-title">{node.label}</text>
      <text x={bounds.x + 14} y={bounds.y + 57} className="fabric-metric">{node.metrics[0]?.value ?? "—"}</text>
      <rect x={bounds.x + 14} y={bounds.y + bounds.height - 11} width={bounds.width - 28} height="5" rx="2.5" className="fabric-gauge-track" />
      <rect x={bounds.x + 14} y={bounds.y + bounds.height - 11} width={(bounds.width - 28) * Math.max(0, Math.min(1, fraction))} height="5" rx="2.5" className="fabric-storage-fill" />
    </g>
  );
}

function GroupNode({ node, model }: { node: FabricNode; model: FabricModel }) {
  const group = model.population.groups.find((item) => item.id === node.id);
  if (!group) return null;
  const { bounds } = node;
  const promoted = group.members.filter((member) =>
    member.attention ||
    (member.cpuFraction !== null && member.cpuFraction >= 0.25) ||
    (member.netRxBps !== null && member.netRxBps >= 1_000_000) ||
    (member.netTxBps !== null && member.netTxBps >= 1_000_000) ||
    (member.blockReadBps !== null && member.blockReadBps >= 1_000_000) ||
    (member.blockWriteBps !== null && member.blockWriteBps >= 1_000_000),
  ).slice(0, 1);
  return (
    <g>
      <text x={bounds.x + 10} y={bounds.y + 18} className="fabric-eyebrow">{node.eyebrow}</text>
      <text x={bounds.x + 10} y={bounds.y + 39} className="fabric-group-title">{node.label}</text>
      {node.metrics.slice(0, 2).map((metric, index) => (
        <text key={metric.label} x={bounds.x + 10 + index * 76} y={bounds.y + 58} className="fabric-metric">
          {metric.value}<tspan className="fabric-metric-label" dx="4">{metric.label}</tspan>
        </text>
      ))}
      {promoted.map((member, index) => (
        <g key={member.id}>
          <circle
            cx={bounds.x + 13}
            cy={bounds.y + 72 + index * 17}
            r="2.7"
            className={member.attention ? "fabric-member-attention" : member.metricCoverage === "unknown" ? "fabric-member-unknown" : "fabric-member"}
          />
          <text x={bounds.x + 22} y={bounds.y + 75 + index * 17} className="fabric-member-label">{member.name}</text>
        </g>
      ))}
    </g>
  );
}

function localStubPath(port: { center: { x: number; y: number }; side: "top" | "right" | "bottom" | "left" }, length = 13): string {
  const { x, y } = port.center;
  const end = port.side === "left" ? { x: x - length, y }
    : port.side === "right" ? { x: x + length, y }
      : port.side === "top" ? { x, y: y - length }
        : { x, y: y + length };
  return `M${x} ${y}L${end.x} ${end.y}`;
}

function relationshipAria(relationship: FabricRelationship): string {
  const rate = relationship.rateBytesPerSecond === null ? "rate unknown" : `${formatCompactRate(relationship.rateBytesPerSecond)}`;
  return `${relationship.label}; ${relationship.direction}; ${relationship.evidence}; ${relationship.freshness}; ${rate}`;
}

function formatCompactRate(rate: number): string {
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)} megabytes per second`;
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)} kilobytes per second`;
  return `${Math.round(rate)} bytes per second`;
}

function formatCompactBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${Math.round(bytes)}B`;
}

export function FabricStage({
  model,
  selection,
  onSelect,
  relationshipsVisible,
  motionEnabled,
}: {
  model: FabricModel;
  selection: FabricSelection | null;
  onSelect: (selection: FabricSelection) => void;
  relationshipsVisible: boolean;
  motionEnabled: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  useFlowScheduler(svgRef, motionEnabled);
  const visibleRelationships = useMemo(() => model.relationships.filter((relationship) =>
    (relationship.plane === "data" && relationship.visibility === "active") ||
    relationshipsVisible ||
    (selection?.kind === "node" && (relationship.fromNodeId === selection.id || relationship.toNodeId === selection.id)) ||
    (selection?.kind === "relationship" && relationship.id === selection.id),
  ), [model.relationships, relationshipsVisible, selection]);
  const selectedNode = selection?.kind === "node" ? selection.id : null;
  const relatedNodeIds = useMemo(() => {
    if (!selectedNode) return new Set<string>();
    const result = new Set([selectedNode]);
    for (const relationship of model.relationships) {
      if (relationship.fromNodeId === selectedNode) result.add(relationship.toNodeId);
      if (relationship.toNodeId === selectedNode) result.add(relationship.fromNodeId);
    }
    return result;
  }, [model.relationships, selectedNode]);
  const uniquePorts = useMemo(() => [...new Map(model.ports.map((port) => [port.id, port])).values()], [model.ports]);
  const portsById = useMemo(() => new Map(uniquePorts.map((port) => [port.id, port])), [uniquePorts]);
  const visibleRelationshipPorts = useMemo(() => new Set(visibleRelationships.flatMap((relationship) => [relationship.fromPortId, relationship.toPortId])), [visibleRelationships]);
  const selectedNodePorts = useMemo(() => new Set(selectedNode ? uniquePorts.filter((port) => port.nodeId === selectedNode).map((port) => port.id) : []), [selectedNode, uniquePorts]);

  return (
    <svg
      ref={svgRef}
      data-fabric-stage
      viewBox={`0 0 ${FABRIC_VIEWBOX.width} ${FABRIC_VIEWBOX.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="group"
      aria-label={`Server fabric; ${model.population.represented} workloads represented`}
    >
      <defs>
        <marker id="fabric-arrow-in" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0 0L7 3.5L0 7Z" fill="rgb(var(--color-flow-in))" />
        </marker>
        <marker id="fabric-arrow-out" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0 0L7 3.5L0 7Z" fill="rgb(var(--color-flow-out))" />
        </marker>
        <marker id="fabric-arrow-control" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0 0L7 3.5L0 7Z" fill="rgb(var(--color-flow-ctl))" />
        </marker>
      </defs>
      <g aria-hidden="true">
        {model.regions.map((region) => (
          <g key={region.id} data-fabric-region={region.id}>
            <text x={region.bounds.x + 11} y={region.bounds.y + 15} className="fabric-region-label">{region.label}</text>
          </g>
        ))}
      </g>

      <g aria-label="Reserved shared trunks">
        {model.trunks.map((trunk) => (
          <g key={trunk.id} data-fabric-trunk={trunk.id}>
            <rect {...trunk.bounds} rx="7" className={`fabric-trunk fabric-trunk-${trunk.kind}`} />
            <text x={trunk.bounds.x + 10} y={trunk.bounds.y + trunk.bounds.height / 2 + 3} className="fabric-bus-title">{trunk.label}</text>
            <text x={trunk.bounds.x + trunk.bounds.width - 10} y={trunk.bounds.y + trunk.bounds.height / 2 + 3} textAnchor="end" className="fabric-eyebrow">{trunk.eyebrow}</text>
          </g>
        ))}
      </g>

      <g aria-label="Local fabric attachment stubs">
        {model.attachments.flatMap((attachment) => {
          const fromPort = portsById.get(attachment.route.fromPortId);
          const toPort = portsById.get(attachment.route.toPortId);
          const nodePort = fromPort?.nodeId === attachment.nodeId ? fromPort : toPort?.nodeId === attachment.nodeId ? toPort : null;
          if (!nodePort || visibleRelationshipPorts.has(nodePort.id)) return [];
          return [<path
            key={attachment.id}
            d={localStubPath(nodePort)}
            className={`fabric-attachment fabric-attachment-${attachment.kind}`}
            data-known={attachment.known}
            data-fabric-attachment-mode="stub"
          />];
        })}
      </g>

      <g aria-label="Observed and declared relationships">
        {visibleRelationships.map((relationship) => {
          const selected = selection?.kind === "relationship" && selection.id === relationship.id;
          const focused = !selectedNode || relationship.fromNodeId === selectedNode || relationship.toNodeId === selectedNode;
          const color = relationship.plane === "control"
            ? "rgb(var(--color-flow-ctl))"
            : relationship.tone === "out"
              ? "rgb(var(--color-flow-out))"
              : relationship.tone === "mixed"
                ? "rgb(var(--color-accent))"
                : "rgb(var(--color-flow-in))";
          const marker = relationship.plane === "control" ? "url(#fabric-arrow-control)" : relationship.tone === "out" ? "url(#fabric-arrow-out)" : "url(#fabric-arrow-in)";
          return (
            <g key={relationship.id} opacity={focused ? 1 : 0.16}>
              <path d={relationship.route.path} className="fabric-flow-halo" strokeWidth={relationship.width + 3} />
              <path
                d={relationship.route.path}
                fill="none"
                stroke={color}
                strokeWidth={selected ? relationship.width + 1.5 : relationship.width}
                strokeDasharray={relationship.plane === "control" ? "3 7" : relationship.animated ? "2 12" : undefined}
                markerEnd={relationship.direction !== "reverse" ? marker : undefined}
                markerStart={relationship.direction === "reverse" || relationship.direction === "bidirectional" ? marker : undefined}
                data-fabric-flow-motion={relationship.animated && motionEnabled}
                data-fabric-route={relationship.id}
                data-fabric-route-from-port={relationship.fromPortId}
                data-fabric-route-to-port={relationship.toPortId}
                data-direction={relationship.direction}
                className="fabric-flow"
                role="button"
                tabIndex={0}
                aria-label={relationshipAria(relationship)}
                onClick={() => onSelect({ kind: "relationship", id: relationship.id })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect({ kind: "relationship", id: relationship.id });
                  }
                }}
              />
            </g>
          );
        })}
      </g>

      <g aria-label="Fabric nodes">
        {model.nodes.map((node) => {
          const selected = selectedNode === node.id;
          const relevant = !selectedNode || relatedNodeIds.has(node.id) || node.kind === "fabric" || node.kind === "resource";
          const view = model.resourceViews.find((item) => item.nodeId === node.id);
          const glyph = node.status === "healthy" ? null : statusGlyph[node.status];
          return (
            <g
              key={node.id}
              data-fabric-node={node.id}
              data-fabric-node-kind={node.kind}
              role={node.kind === "fabric" ? undefined : "button"}
              tabIndex={node.kind === "fabric" ? undefined : 0}
              aria-label={`${node.label}; ${node.status}; ${node.metrics.map((metric) => `${metric.label} ${metric.value}`).join(", ") || "no active values"}`}
              opacity={relevant ? 1 : 0.24}
              className={node.kind === "fabric" ? "" : "fabric-node-interactive"}
              onClick={node.kind === "fabric" ? undefined : () => onSelect({ kind: "node", id: node.id })}
              onKeyDown={node.kind === "fabric" ? undefined : (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect({ kind: "node", id: node.id });
                }
              }}
            >
              <rect
                {...node.bounds}
                rx={node.kind === "fabric" ? 8 : 11}
                className={`fabric-node fabric-node-${node.kind}${selected ? " fabric-node-selected" : ""}`}
                stroke={selected ? "rgb(var(--color-accent))" : statusStroke(node.status)}
              />
              {node.kind === "fabric" ? (
                <>
                  {node.bounds.width > 300 ? (
                    <>
                      <text x={node.bounds.x + 11} y={node.bounds.y + node.bounds.height / 2 + 4} className="fabric-bus-title">{node.label}</text>
                      <text x={node.bounds.x + node.bounds.width - 11} y={node.bounds.y + node.bounds.height / 2 + 4} textAnchor="end" className="fabric-eyebrow">{node.eyebrow}</text>
                    </>
                  ) : node.bounds.height >= 48 ? (
                    <>
                      <text x={node.bounds.x + 10} y={node.bounds.y + 18} className="fabric-eyebrow">{node.eyebrow}</text>
                      <text x={node.bounds.x + 10} y={node.bounds.y + 39} className="fabric-bus-title">{node.label}</text>
                    </>
                  ) : (
                    <text x={node.bounds.x + 10} y={node.bounds.y + node.bounds.height / 2 + 3} className="fabric-bus-title">
                      {node.label}
                    </text>
                  )}
                </>
              ) : node.kind === "resource" ? (
                <ResourceNode node={node} view={view} selectedNodeId={selectedNode} />
              ) : node.kind === "workload" ? (
                <WorkloadNode node={node} />
              ) : node.kind === "storage" ? (
                <StorageNode node={node} />
              ) : (
                <GroupNode node={node} model={model} />
              )}
              {glyph ? (
                <g aria-hidden="true">
                  <circle cx={node.bounds.x + node.bounds.width - 12} cy={node.bounds.y + 13} r="8" fill="rgb(var(--color-bg))" stroke={statusStroke(node.status)} />
                  <text x={node.bounds.x + node.bounds.width - 12} y={node.bounds.y + 16} textAnchor="middle" className="fabric-state-glyph">{glyph}</text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>

      <g aria-hidden="true">
        {uniquePorts.filter((port) => relationshipsVisible || visibleRelationshipPorts.has(port.id) || selectedNodePorts.has(port.id)).map((port) => (
          <g key={port.id}>
            <circle
              cx={port.center.x}
              cy={port.center.y}
              r="5.4"
              className={`fabric-port fabric-port-${port.kind}`}
              data-fabric-port={port.id}
              data-fabric-port-node={port.nodeId}
              data-fabric-port-kind={port.kind}
            />
            <circle cx={port.center.x} cy={port.center.y} r="1.6" className="fabric-port-core" />
          </g>
        ))}
      </g>
    </svg>
  );
}
