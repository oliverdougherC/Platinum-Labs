"use client";

import { useEffect, useMemo, useState } from "react";
import type { FabricModel } from "@/lib/fabric/model";
import type {
  FabricCompositionJunction,
  FabricCompositionNode,
  FabricCompositionScene,
  FabricPhysicalSegment,
} from "@/lib/fabric/composition-study";
import type { FabricResourceContribution } from "@/lib/fabric/model";

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

function ResourceGraphic({ node, selectedContribution }: {
  node: FabricCompositionNode;
  selectedContribution: FabricResourceContribution | null;
}) {
  const view = node.resourceView;
  if (!view) return null;
  const { bounds } = node;
  const x = bounds.x + 12;
  const width = bounds.width - 24;
  const selectedFraction = Math.max(0, Math.min(1, selectedContribution?.fraction ?? 0));
  if (view.id === "cpu") {
    const count = Math.max(1, view.segments.length);
    const columns = Math.min(16, Math.ceil(Math.sqrt(count * 3.2)));
    const rows = Math.ceil(count / columns);
    const gap = 2;
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = Math.max(2.5, (18 - gap * (rows - 1)) / rows);
    return (
      <g className="fabric-study-resource-graphic" aria-hidden="true">
        {view.segments.map((fraction, index) => (
          <rect
            key={index}
            x={x + (index % columns) * (cellWidth + gap)}
            y={bounds.y + 49 + Math.floor(index / columns) * (cellHeight + gap)}
            width={cellWidth}
            height={cellHeight}
            rx="1.2"
            style={{ opacity: 0.18 + Math.max(0, Math.min(1, fraction)) * 0.82 }}
          />
        ))}
        {selectedContribution ? <rect x={x} y={bounds.y + 72} width={width * selectedFraction} height="2.5" rx="1.25" className="fabric-study-resource-selected" /> : null}
      </g>
    );
  }
  const fractions = view.id === "gpu" ? view.segments.slice(0, 2) : [view.fraction ?? view.segments[0] ?? 0];
  return (
    <g className="fabric-study-resource-graphic" aria-hidden="true">
      {fractions.map((fraction, index) => (
        <g key={index}>
          <rect x={x} y={bounds.y + 50 + index * 13} width={width} height="5" rx="2.5" className="fabric-study-resource-track" />
          <rect x={x} y={bounds.y + 50 + index * 13} width={width * Math.max(0, Math.min(1, fraction))} height="5" rx="2.5" />
        </g>
      ))}
      {selectedContribution && (view.id === "memory") ? <rect x={x} y={bounds.y + 70} width={width * selectedFraction} height="3" rx="1.5" className="fabric-study-resource-selected" /> : null}
    </g>
  );
}

function NodeCard({ node, selected, related, selectedContribution, onSelect }: {
  node: FabricCompositionNode;
  selected: boolean;
  related: boolean;
  selectedContribution: FabricResourceContribution | null;
  onSelect: () => void;
}) {
  const { bounds } = node;
  const status = statusSymbol[node.status];
  const micro = bounds.height < 42;
  const subsystem = node.role === "subsystem";
  const resource = node.role === "resource";
  const storage = node.role === "storage";
  const metricY = bounds.y + (subsystem ? 53 : storage ? bounds.height - 8 : Math.min(64, bounds.height - 9));
  const metricWidth = Math.max(66, (bounds.width - 24) / Math.max(1, Math.min(2, node.metrics.length)));
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
      <rect data-study-node-box {...bounds} rx={resource ? 7 : node.role === "data-plane" ? 14 : 9} className="fabric-study-card" />
      {!micro ? <text data-study-essential-text data-owner-node={node.sourceNodeId} x={bounds.x + 12} y={bounds.y + (subsystem ? 14 : 18)} className="fabric-study-eyebrow">{node.eyebrow}</text> : null}
      <text data-study-essential-text data-owner-node={node.sourceNodeId} x={bounds.x + 12} y={bounds.y + (micro ? bounds.height / 2 + 5 : subsystem ? 34 : storage ? 37 : 39)} className="fabric-study-title">{node.label}</text>
      {resource ? <ResourceGraphic node={node} selectedContribution={selectedContribution} /> : null}
      {!micro && !resource ? node.metrics.slice(0, 2).map((metric, index) => (
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
      {resource && node.resourceView ? (
        <text data-study-essential-text data-owner-node={node.sourceNodeId} x={bounds.x + bounds.width - 12} y={bounds.y + 37} textAnchor="end" className="fabric-study-metric">
          {selectedContribution ? `${selectedContribution.coverage === "partial" ? "≈" : ""}${selectedContribution.value === null ? "—" : node.resourceView.id === "cpu" ? `${selectedContribution.value.toFixed(2)}c` : `${(selectedFraction(selectedContribution) * 100).toFixed(1)}%`} selected` : node.resourceView.primary}
        </text>
      ) : null}
      {node.promoted.slice(0, 1).map((name) => (
        <text
          key={name}
          data-study-essential-text
          data-study-promoted
          data-owner-node={node.sourceNodeId}
          x={bounds.x + bounds.width - 12}
          y={bounds.y + (subsystem ? 34 : 39)}
          textAnchor="end"
          className="fabric-study-promoted"
        >
          {name}
        </text>
      ))}
      {status && !micro ? (
        <g aria-hidden="true">
          <circle cx={bounds.x + bounds.width - 13} cy={bounds.y + 14} r="7" className="fabric-study-status" />
          <text x={bounds.x + bounds.width - 13} y={bounds.y + 17} textAnchor="middle" className="fabric-study-status-text">{status}</text>
        </g>
      ) : null}
      {node.ports.map((port) => (
        <g key={port.id} data-study-port-id={port.id} data-study-port-kind={port.kind} data-study-port-center={`${port.center.x},${port.center.y}`} aria-hidden="true">
          <circle cx={port.center.x} cy={port.center.y} r="3.8" className={`fabric-study-port fabric-study-port-${port.kind}`} />
          <circle cx={port.center.x} cy={port.center.y} r="1.15" className="fabric-study-port-core" />
        </g>
      ))}
    </g>
  );
}

function selectedFraction(contribution: FabricResourceContribution): number {
  return Math.max(0, Math.min(1, contribution.fraction ?? 0));
}

function Segment({ segment, active, focused }: { segment: FabricPhysicalSegment; active: boolean; focused: boolean }) {
  const d = pathData(segment);
  const structural = segment.id.endsWith(":rail") || segment.id.endsWith(":substrate") || segment.id.includes(":trunk");
  return (
    <g
      data-study-segment-group={segment.id}
      data-study-segment-plane={segment.plane}
      className={`fabric-study-segment-group ${structural ? "is-structural" : "is-branch"}${active ? " is-active" : ""}${focused ? " is-focused" : ""}`}
    >
      <path d={d} className={`fabric-study-substrate fabric-study-substrate-${segment.plane}`} />
      {active ? <path
        d={d}
        data-study-segment={segment.id}
        data-study-points={segment.points.map((point) => `${point.x},${point.y}`).join(";")}
        data-study-endpoint-a={segment.endpointIds[0]}
        data-study-endpoint-b={segment.endpointIds[1]}
        data-study-junction-ids={segment.junctionIds.join(",")}
        data-study-logical-contributors={segment.logicalContributorIds.join(",")}
        data-study-directions={segment.directions.join(",")}
        className={`fabric-study-channel fabric-study-channel-${segment.plane}`}
      /> : <path
        d={d}
        data-study-segment={segment.id}
        data-study-points={segment.points.map((point) => `${point.x},${point.y}`).join(";")}
        data-study-endpoint-a={segment.endpointIds[0]}
        data-study-endpoint-b={segment.endpointIds[1]}
        data-study-junction-ids={segment.junctionIds.join(",")}
        data-study-logical-contributors={segment.logicalContributorIds.join(",")}
        data-study-directions=""
        className="fabric-study-channel fabric-study-channel-dormant"
      />}
      {segment.label ? (
        <g
          data-study-segment-label={segment.id}
          data-study-label-bounds={`${segment.labelBounds.x},${segment.labelBounds.y},${segment.labelBounds.width},${segment.labelBounds.height}`}
        >
          <rect {...segment.labelBounds} rx="4" className="fabric-study-label-backdrop" />
          <text x={segment.labelBounds.x + 6} y={segment.labelBounds.y + 11} className="fabric-study-segment-label">{segment.label}</text>
        </g>
      ) : null}
    </g>
  );
}

function Junction({ junction }: { junction: FabricCompositionJunction }) {
  return (
    <g
      data-study-junction={junction.id}
      data-study-junction-kind={junction.kind}
      data-study-junction-plane={junction.plane}
      data-study-junction-point={`${junction.point.x},${junction.point.y}`}
      className={`fabric-study-junction fabric-study-junction-${junction.plane} fabric-study-junction-${junction.kind}`}
      aria-hidden="true"
    >
      {junction.kind === "via" ? <circle cx={junction.point.x} cy={junction.point.y} r="5.2" className="fabric-study-via-cutout" /> : null}
      <circle cx={junction.point.x} cy={junction.point.y} r={junction.kind === "via" ? 3.1 : 2.7} className="fabric-study-junction-ring" />
      <circle cx={junction.point.x} cy={junction.point.y} r="1.15" className="fabric-study-junction-core" />
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
  const relationshipById = useMemo(() => new Map(model.relationships.map((relationship) => [relationship.id, relationship])), [model.relationships]);
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
          data-study-density={`${scene.density.occupiedCellRatio},${scene.density.largestInternalVoid}`}
          data-study-density-columns={scene.density.columns.join(",")}
          data-study-density-rows={scene.density.rows.join(",")}
          data-study-storage-corridors={scene.primaryStorageCorridors.map((corridor) => `${corridor.nodeId}:${corridor.bounds.x},${corridor.bounds.y},${corridor.bounds.width},${corridor.bounds.height}`).join(";")}
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
          <g aria-hidden="true">
            {scene.logicalRoutes.map((route) => (
              <g
                key={route.relationshipId}
                data-study-logical-route={route.relationshipId}
                data-study-route-from={route.fromNodeId}
                data-study-route-to={route.toNodeId}
                data-study-route-segments={route.segmentIds.join(",")}
              />
            ))}
            {scene.primaryStorageCorridors.map((corridor) => (
              <g
                key={corridor.nodeId}
                data-study-storage-corridor={corridor.nodeId}
                data-study-corridor-bounds={`${corridor.bounds.x},${corridor.bounds.y},${corridor.bounds.width},${corridor.bounds.height}`}
              />
            ))}
          </g>
          <g aria-label="Planar physical segment graph">
            {scene.segments.map((segment) => {
              const focused = segment.logicalContributorIds.some((id) => focusedRelationshipIds.has(id));
              const active = !quiet && segment.logicalContributorIds.some((id) => relationshipById.get(id)?.visibility === "active");
              return <Segment key={segment.id} segment={segment} active={active || focused} focused={focused} />;
            })}
          </g>
          <g aria-label="Physical junction and via geometry">
            {scene.junctions.map((junction) => <Junction key={junction.id} junction={junction} />)}
          </g>
          <g aria-label="Fabric composition nodes">
            {scene.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={selectedId === node.sourceNodeId}
                related={!selectedId || relatedNodeIds.has(node.sourceNodeId) || node.role === "resource"}
                selectedContribution={node.resourceView?.contributors?.find((contribution) => contribution.nodeId === selectedId) ?? null}
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
