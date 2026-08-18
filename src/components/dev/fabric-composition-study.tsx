"use client";

import { useEffect, useMemo, useState } from "react";
import type { FabricModel } from "@/lib/fabric/model";
import type {
  FabricCompositionNode,
  FabricCompositionScene,
  FabricPhysicalSegment,
} from "@/lib/fabric/composition-study";

const statusSymbol = {
  healthy: null,
  degraded: "!",
  unavailable: "×",
  stale: "S",
  "not-configured": "–",
  unknown: "?",
} as const;

function pathData(segment: FabricPhysicalSegment): string {
  return segment.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
}

function NodeCard({ node, selected, related, onSelect }: {
  node: FabricCompositionNode;
  selected: boolean;
  related: boolean;
  onSelect: () => void;
}) {
  const { bounds } = node;
  const status = statusSymbol[node.status];
  const compact = bounds.height < 55;
  const metricY = bounds.y + Math.min(60, bounds.height - 8);
  const metricWidth = Math.max(70, (bounds.width - 24) / Math.max(1, Math.min(3, node.metrics.length)));
  return (
    <g
      data-study-node={node.sourceNodeId}
      data-study-node-role={node.role}
      data-study-node-bounds={`${bounds.x},${bounds.y},${bounds.width},${bounds.height}`}
      data-study-member-ids={node.memberIds.join(",")}
      className={`fabric-study-node fabric-study-node-${node.role}${selected ? " is-selected" : ""}${related ? " is-related" : ""}`}
      role={node.kind === "fabric" ? undefined : "button"}
      tabIndex={node.kind === "fabric" ? undefined : 0}
      aria-label={`${node.label}; ${node.status}; ${node.metrics.map((metric) => `${metric.label} ${metric.value}`).join(", ")}`}
      onClick={node.kind === "fabric" ? undefined : onSelect}
      onKeyDown={node.kind === "fabric" ? undefined : (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <rect data-study-node-box {...bounds} rx={node.role === "resource" ? 10 : 12} className="fabric-study-card" />
      {!compact ? <text data-study-essential-text data-owner-node={node.sourceNodeId} x={bounds.x + 12} y={bounds.y + 18} className="fabric-study-eyebrow">{node.eyebrow}</text> : null}
      <text data-study-essential-text data-owner-node={node.sourceNodeId} x={bounds.x + 12} y={bounds.y + (compact ? bounds.height / 2 + 5 : 39)} className="fabric-study-title">{node.label}</text>
      {!compact ? node.metrics.slice(0, 3).map((metric, index) => (
        <text
          key={`${metric.label}-${index}`}
          data-study-essential-text
          data-owner-node={node.sourceNodeId}
          x={bounds.x + 12 + index * metricWidth}
          y={metricY}
          className="fabric-study-metric"
        >
          {metric.value}<tspan dx="4" className="fabric-study-metric-label">{metric.label}</tspan>
        </text>
      )) : null}
      {node.promoted.slice(0, 1).map((name) => (
        <text
          key={name}
          data-study-essential-text
          data-study-promoted
          data-owner-node={node.sourceNodeId}
          x={bounds.x + bounds.width - 12}
          y={bounds.y + 39}
          textAnchor="end"
          className="fabric-study-promoted"
        >
          {name}
        </text>
      ))}
      {status ? (
        <g aria-hidden="true">
          <circle cx={bounds.x + bounds.width - 13} cy={bounds.y + 14} r="7" className="fabric-study-status" />
          <text x={bounds.x + bounds.width - 13} y={bounds.y + 17} textAnchor="middle" className="fabric-study-status-text">{status}</text>
        </g>
      ) : null}
      {node.portKinds.map((kind, index) => (
        <g key={kind} data-study-port-kind={kind} aria-hidden="true">
          <circle cx={bounds.x + bounds.width - 12 - index * 13} cy={bounds.y + bounds.height} r="3.5" className={`fabric-study-port fabric-study-port-${kind}`} />
          <circle cx={bounds.x + bounds.width - 12 - index * 13} cy={bounds.y + bounds.height} r="1.1" className="fabric-study-port-core" />
        </g>
      ))}
    </g>
  );
}

function Segment({ segment, active, focused }: { segment: FabricPhysicalSegment; active: boolean; focused: boolean }) {
  const d = pathData(segment);
  return (
    <g
      data-study-segment-group={segment.id}
      data-study-segment-plane={segment.plane}
      className={`fabric-study-segment-group${active ? " is-active" : ""}${focused ? " is-focused" : ""}`}
    >
      <path d={d} className={`fabric-study-substrate fabric-study-substrate-${segment.plane}`} />
      {active ? <path
        d={d}
        data-study-segment={segment.id}
        data-study-points={segment.points.map((point) => `${point.x},${point.y}`).join(";")}
        data-study-endpoint-a={segment.endpointIds[0]}
        data-study-endpoint-b={segment.endpointIds[1]}
        data-study-logical-contributors={segment.logicalContributorIds.join(",")}
        data-study-directions={segment.directions.join(",")}
        className={`fabric-study-channel fabric-study-channel-${segment.plane}`}
      /> : <path
        d={d}
        data-study-segment={segment.id}
        data-study-points={segment.points.map((point) => `${point.x},${point.y}`).join(";")}
        data-study-endpoint-a={segment.endpointIds[0]}
        data-study-endpoint-b={segment.endpointIds[1]}
        data-study-logical-contributors={segment.logicalContributorIds.join(",")}
        data-study-directions=""
        className="fabric-study-channel fabric-study-channel-dormant"
      />}
      <g
        data-study-segment-label={segment.id}
        data-study-label-bounds={`${segment.labelBounds.x},${segment.labelBounds.y},${segment.labelBounds.width},${segment.labelBounds.height}`}
      >
        <rect {...segment.labelBounds} rx="4" className="fabric-study-label-backdrop" />
        <text x={segment.labelBounds.x + 6} y={segment.labelBounds.y + 11} className="fabric-study-segment-label">{segment.label}</text>
      </g>
    </g>
  );
}

function Inspector({ scene, model, selectedId, onClose }: {
  scene: FabricCompositionScene;
  model: FabricModel;
  selectedId: string;
  onClose: () => void;
}) {
  const node = scene.nodes.find((candidate) => candidate.sourceNodeId === selectedId);
  if (!node) return null;
  const group = model.population.groups.find((candidate) => candidate.id === selectedId);
  const relationships = model.relationships.filter((relationship) => relationship.fromNodeId === selectedId || relationship.toNodeId === selectedId);
  return (
    <aside data-study-inspector className="fabric-study-inspector" aria-label={`${node.label} inspector`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Composition inspector</p>
          <h2 className="mt-1 truncate text-sm font-medium text-fg">{node.label}</h2>
          <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted">{node.role} · {node.status}</p>
        </div>
        <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline text-muted hover:border-border hover:text-fg" aria-label="Close composition inspector">×</button>
      </div>
      {node.metrics.length ? (
        <dl className="mt-4 grid grid-cols-2 gap-2">
          {node.metrics.slice(0, 4).map((metric) => (
            <div key={metric.label} className="min-w-0 rounded-lg border border-hairline/70 bg-surface/35 px-2 py-2">
              <dt className="truncate text-[9px] uppercase tracking-[0.1em] text-faint">{metric.label}</dt>
              <dd className="tnum mt-1 truncate text-[11px] text-fg">{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {relationships.length ? (
        <section className="mt-4">
          <h3 className="text-[9px] uppercase tracking-[0.14em] text-faint">Logical contributors · {relationships.length}</h3>
          <ul className="mt-2 divide-y divide-hairline/60">
            {relationships.slice(0, 6).map((relationship) => (
              <li key={relationship.id} className="py-2 text-[11px] text-muted">
                <span className="block truncate">{relationship.label}</span>
                <span className="mt-1 block text-[9px] uppercase tracking-[0.1em] text-faint">{relationship.evidence} · {relationship.plane}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {group ? (
        <section className="mt-4 min-h-0">
          <h3 className="text-[9px] uppercase tracking-[0.14em] text-faint">Named subsystem members · {group.members.length}</h3>
          <ul className="mt-2 max-h-[38vh] divide-y divide-hairline/60 overflow-y-auto pr-1">
            {group.members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2 py-1.5 text-[10px]">
                <span className="truncate text-muted">{member.name}</span>
                <span className={member.attention ? "text-warn" : "text-faint"}>{member.attention ? "attention" : member.state}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

export function FabricCompositionStudy({
  scene,
  model,
  quiet,
  initialFocus,
}: {
  scene: FabricCompositionScene;
  model: FabricModel;
  quiet: boolean;
  initialFocus: string | null;
}) {
  const normalizedFocus = initialFocus ? (initialFocus.startsWith("service:") || initialFocus.startsWith("group:") || initialFocus.startsWith("pool:") ? initialFocus : `service:${initialFocus}`) : null;
  const [selectedId, setSelectedId] = useState(normalizedFocus);
  useEffect(() => setSelectedId(normalizedFocus), [normalizedFocus]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const focusedRelationshipIds = useMemo(() => new Set(
    selectedId ? model.relationships.filter((relationship) => relationship.fromNodeId === selectedId || relationship.toNodeId === selectedId).map((relationship) => relationship.id) : [],
  ), [model.relationships, selectedId]);
  const relatedNodeIds = useMemo(() => {
    const result = new Set<string>();
    if (!selectedId) return result;
    result.add(selectedId);
    for (const relationship of model.relationships) {
      if (relationship.fromNodeId === selectedId) result.add(relationship.toNodeId);
      if (relationship.toNodeId === selectedId) result.add(relationship.fromNodeId);
    }
    return result;
  }, [model.relationships, selectedId]);

  return (
    <main
      data-study-shell
      data-study-id={scene.id}
      data-study-mode={quiet ? "quiet" : "mixed"}
      data-study-inspector-open={selectedId ? "true" : "false"}
      className="fabric-study-shell"
    >
      <section data-study-stage-frame className="fabric-study-stage-frame" aria-label={scene.title}>
        <div className="fabric-study-heading">
          <div>
            <p>V3 composition study · deterministic 44-container fixture</p>
            <h1>{scene.title}</h1>
          </div>
          <p className="fabric-study-thesis">{scene.thesis}</p>
        </div>
        <svg
          data-study-stage
          data-study-population-count={scene.representedIds.length}
          data-study-population-ids={scene.representedIds.join(",")}
          data-study-summary-ids={scene.summaryIds.join(",")}
          data-study-logical-route-count={scene.logicalRoutes.length}
          data-study-occupied-bounds={`${scene.occupiedBounds.x},${scene.occupiedBounds.y},${scene.occupiedBounds.width},${scene.occupiedBounds.height}`}
          viewBox={`0 0 ${scene.viewBox.width} ${scene.viewBox.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`${scene.title}; ${scene.representedIds.length} containers represented by named workloads and subsystem summaries`}
        >
          <defs>
            <filter id={`study-glow-${scene.id}`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2.4" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <text x="24" y="20" className="fabric-study-region-label">HARDWARE ACCOUNTING · RESOURCE PLANE · NO ROUTES</text>
          <g aria-label="Planar physical segment graph">
            {scene.segments.map((segment) => {
              const focused = segment.logicalContributorIds.some((id) => focusedRelationshipIds.has(id));
              const active = !quiet && segment.logicalContributorIds.length > 0;
              return <Segment key={segment.id} segment={segment} active={active} focused={focused} />;
            })}
          </g>
          <g aria-label="Fabric composition nodes">
            {scene.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={selectedId === node.sourceNodeId}
                related={!selectedId || relatedNodeIds.has(node.sourceNodeId) || node.role === "resource"}
                onSelect={() => setSelectedId((current) => current === node.sourceNodeId ? null : node.sourceNodeId)}
              />
            ))}
          </g>
        </svg>
      </section>
      {selectedId ? <Inspector scene={scene} model={model} selectedId={selectedId} onClose={() => setSelectedId(null)} /> : null}
    </main>
  );
}
