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

function ResourceNode({ node, view }: { node: FabricNode; view: FabricResourceView | undefined }) {
  const { bounds } = node;
  const segments = view?.segments ?? [];
  const maxSegments = node.id === "resource:cpu" ? 32 : 2;
  const shown = segments.slice(0, maxSegments);
  const columns = node.id === "resource:cpu" ? 16 : 1;
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
      {node.id === "resource:cpu" ? shown.map((value, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        const x = bounds.x + 14 + col * 13.4;
        const y = bounds.y + 82 + row * 24;
        return (
          <g key={index}>
            <rect x={x} y={y} width="8" height="17" rx="1" className="fabric-gauge-track" />
            <rect x={x} y={y + 17 * (1 - Math.min(1, value))} width="8" height={17 * Math.min(1, value)} rx="1" className="fabric-gauge-fill" />
          </g>
        );
      }) : (
        <>
          <rect x={bounds.x + 14} y={bounds.y + bounds.height - 20} width={bounds.width - 28} height="6" rx="3" className="fabric-gauge-track" />
          {view?.fraction !== null && view?.fraction !== undefined ? (
            <rect x={bounds.x + 14} y={bounds.y + bounds.height - 20} width={(bounds.width - 28) * Math.max(0, Math.min(1, view.fraction))} height="6" rx="3" className="fabric-gauge-fill" />
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
      <text x={bounds.x + 13} y={bounds.y + 19} className="fabric-eyebrow">{node.eyebrow}</text>
      <text x={bounds.x + 13} y={bounds.y + 45} className="fabric-service-title">{node.label}</text>
      {node.metrics.slice(0, 2).map((metric, index) => (
        <text key={metric.label} x={bounds.x + 13 + index * 74} y={bounds.y + 65} className="fabric-metric">
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
      <text x={bounds.x + 14} y={bounds.y + 45} className="fabric-service-title">{node.label}</text>
      <text x={bounds.x + 14} y={bounds.y + 66} className="fabric-metric">{node.metrics[0]?.value ?? "—"}</text>
      <rect x={bounds.x + 14} y={bounds.y + 81} width={bounds.width - 28} height="6" rx="3" className="fabric-gauge-track" />
      <rect x={bounds.x + 14} y={bounds.y + 81} width={(bounds.width - 28) * Math.max(0, Math.min(1, fraction))} height="6" rx="3" className="fabric-storage-fill" />
    </g>
  );
}

function GroupNode({ node, model }: { node: FabricNode; model: FabricModel }) {
  const group = model.population.groups.find((item) => item.id === node.id);
  if (!group) return null;
  const { bounds } = node;
  const columns = 10;
  const maxVisible = 140;
  return (
    <g>
      <text x={bounds.x + 10} y={bounds.y + 18} className="fabric-eyebrow">{node.eyebrow}</text>
      <text x={bounds.x + 10} y={bounds.y + 39} className="fabric-group-title">{node.label}</text>
      {group.members.length <= 8 ? group.members.map((member, index) => (
        <g key={member.id}>
          <circle
            cx={bounds.x + 13}
            cy={bounds.y + 57 + index * 17}
            r="2.7"
            className={member.attention ? "fabric-member-attention" : member.metricCoverage === "unknown" ? "fabric-member-unknown" : "fabric-member"}
          />
          <text x={bounds.x + 22} y={bounds.y + 60 + index * 17} className="fabric-member-label">{member.name}</text>
        </g>
      )) : group.members.slice(0, maxVisible).map((member, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        return (
          <g key={member.id}>
            <rect
              x={bounds.x + 10 + col * 10.2}
              y={bounds.y + 53 + row * 9.5}
              width="6.5"
              height="6.5"
              rx="1.5"
              className={member.attention ? "fabric-member-attention" : member.metricCoverage === "unknown" ? "fabric-member-unknown" : "fabric-member"}
            />
          </g>
        );
      })}
      {group.members.length > maxVisible ? (
        <text x={bounds.x + 10} y={bounds.y + bounds.height - 10} className="fabric-eyebrow">+{group.members.length - maxVisible} represented in details</text>
      ) : null}
    </g>
  );
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
    relationship.visibility === "active" ||
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
        <pattern id="fabric-grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" stroke="rgb(var(--color-hairline))" strokeOpacity="0.16" strokeWidth="0.5" />
        </pattern>
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
      <rect width="1200" height="640" fill="url(#fabric-grid)" opacity="0.72" />

      <g aria-hidden="true">
        {model.regions.map((region) => (
          <g key={region.id}>
            <rect {...region.bounds} rx="15" className="fabric-region" />
            <text x={region.bounds.x + 11} y={region.bounds.y + 15} className="fabric-region-label">{region.label}</text>
          </g>
        ))}
      </g>

      <g aria-label="Stable fabric attachments">
        {model.attachments.map((attachment) => (
          <path
            key={attachment.id}
            d={attachment.route.path}
            className={`fabric-attachment fabric-attachment-${attachment.kind}`}
            data-known={attachment.known}
          />
        ))}
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
              <path d={relationship.route.path} className="fabric-flow-halo" strokeWidth={relationship.width + 7} />
              <path
                d={relationship.route.path}
                fill="none"
                stroke={color}
                strokeWidth={selected ? relationship.width + 1.5 : relationship.width}
                strokeDasharray={relationship.plane === "control" ? "3 7" : relationship.animated ? "2 12" : undefined}
                markerEnd={relationship.direction !== "reverse" ? marker : undefined}
                markerStart={relationship.direction === "reverse" || relationship.direction === "bidirectional" ? marker : undefined}
                data-fabric-flow-motion={relationship.animated && motionEnabled}
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
                  {node.bounds.width > 100 ? (
                    <>
                      <text x={node.bounds.x + 11} y={node.bounds.y + node.bounds.height / 2 + 4} className="fabric-bus-title">{node.label}</text>
                      <text x={node.bounds.x + node.bounds.width - 11} y={node.bounds.y + node.bounds.height / 2 + 4} textAnchor="end" className="fabric-eyebrow">{node.eyebrow}</text>
                    </>
                  ) : (
                    <text
                      x={node.bounds.x + node.bounds.width / 2}
                      y={node.bounds.y + node.bounds.height / 2}
                      textAnchor="middle"
                      className="fabric-bus-title"
                      transform={`rotate(-90 ${node.bounds.x + node.bounds.width / 2} ${node.bounds.y + node.bounds.height / 2})`}
                    >
                      STORAGE · {node.label}
                    </text>
                  )}
                </>
              ) : node.kind === "resource" ? (
                <ResourceNode node={node} view={view} />
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
        {uniquePorts.map((port) => (
          <g key={port.id}>
            <circle cx={port.center.x} cy={port.center.y} r="5.4" className={`fabric-port fabric-port-${port.kind}`} />
            <circle cx={port.center.x} cy={port.center.y} r="1.6" className="fabric-port-core" />
          </g>
        ))}
      </g>
    </svg>
  );
}
