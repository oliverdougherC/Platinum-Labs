"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DrawerShell } from "@/components/ui/overlay-shell";
import { buildFabricComposition, type FabricCompositionId } from "@/lib/fabric/composition-study";
import {
  type FabricModel,
  type FabricRelationship,
} from "@/lib/fabric/model";
import type {
  FabricCompositionJunction,
  FabricCompositionNode,
  FabricCompositionScene,
  FabricLogicalRoute,
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

export type FabricCompositionViewMode = "activity" | "relationship-map";
export type FabricTopologyState = "live" | "last-known" | "incomplete";

export function FabricCompositionIncomplete() {
  return (
    <main
      data-fabric-mount
      data-ui-mode="fabric"
      data-fabric-topology="incomplete"
      data-study-shell
      data-study-id="A+"
      data-study-mode="quiet"
      data-study-view-mode="activity"
      data-study-inspector-open="false"
      data-motion="off"
      className="fabric-study-shell fabric-ground"
    >
      <section className="fabric-study-stage-frame" aria-label="Server fabric topology incomplete">
        <svg
          data-study-stage
          data-fabric-stage
          viewBox="0 0 1480 900"
          role="group"
          aria-label="Server fabric; 0 workloads represented; Docker topology has not been observed"
        >
          <text x="740" y="438" textAnchor="middle" className="fabric-study-title fabric-title">
            Docker topology not yet observed
          </text>
          <text x="740" y="466" textAnchor="middle" className="fabric-study-metric">
            Waiting for the first complete inventory snapshot
          </text>
        </svg>
      </section>
    </main>
  );
}
export type StudyRelationshipActivityState =
  | "live-transfer"
  | "live-state-only"
  | "stale"
  | "confirmed-zero"
  | "unknown"
  | "dormant-structural";

interface RelationshipPresentation {
  state: StudyRelationshipActivityState;
  animated: boolean;
  width: number;
  motionSeconds: number;
  direction: FabricRelationship["direction"] | "none";
}

interface SegmentPresentation {
  visible: boolean;
  focused: boolean;
  active: boolean;
  structural: boolean;
  animated: boolean;
  state: StudyRelationshipActivityState;
  width: number;
  motionSeconds: number;
  direction: FabricRelationship["direction"] | "none";
  showLabel: boolean;
}

interface FocusSummary {
  summary: string;
  connectivity: string;
  peers: string[];
}

type SceneFocusMetadata = Partial<Record<
  string,
  {
    summary?: string;
    connectivity?: string;
    peers?: string[];
  }
>>;

const ACTIVITY_PRIORITY: StudyRelationshipActivityState[] = [
  "live-transfer",
  "live-state-only",
  "stale",
  "unknown",
  "confirmed-zero",
  "dormant-structural",
];

function pathData(segment: FabricPhysicalSegment): string {
  return segment.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join("");
}

function selectedFraction(contribution: FabricResourceContribution): number {
  return Math.max(0, Math.min(1, contribution.fraction ?? 0));
}

function isStructuralSegment(segment: FabricPhysicalSegment): boolean {
  return segment.id.endsWith(":rail") || segment.id.endsWith(":substrate") || segment.id.endsWith("-trunk") || segment.id.includes(":trunk");
}

function isPrincipalQuietSegment(segment: FabricPhysicalSegment): boolean {
  return segment.id === "segment:a-plus:host-network-trunk" ||
    segment.id === "segment:a-plus:read:substrate" ||
    segment.id === "segment:a-plus:write:substrate";
}

function compactRate(rate: number | null): string {
  if (rate === null) return "unknown";
  if (rate >= 1_000_000_000) return `${(rate / 1_000_000_000).toFixed(1)}G/s`;
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M/s`;
  if (rate >= 1_000) return `${Math.round(rate / 1_000)}K/s`;
  return `${Math.round(rate)}B/s`;
}

function normalizeActivityState(value: unknown): StudyRelationshipActivityState | null {
  if (typeof value !== "string") return null;
  if (value === "dormant") return "dormant-structural";
  return ACTIVITY_PRIORITY.includes(value as StudyRelationshipActivityState)
    ? value as StudyRelationshipActivityState
    : null;
}

export function resolveStudyRelationshipState(relationship: FabricRelationship): StudyRelationshipActivityState {
  const explicit = normalizeActivityState(relationship.renderedActivity);
  if (explicit) return explicit;
  if (relationship.freshness === "stale") return "stale";
  if (relationship.rateBytesPerSecond !== null) {
    if (relationship.rateBytesPerSecond > 0) return "live-transfer";
    if (relationship.rateBytesPerSecond === 0) return "confirmed-zero";
  }
  if (relationship.evidence === "state-only" || relationship.plane === "control" || relationship.visibility === "focus") {
    return "live-state-only";
  }
  if (relationship.plane === "data" && relationship.freshness === "live" && relationship.rateBytesPerSecond === null) return "unknown";
  if (relationship.freshness === "unknown" || relationship.coverage === "unknown") return "unknown";
  return "dormant-structural";
}

function relationshipPresentation(relationship: FabricRelationship, motionEnabled: boolean): RelationshipPresentation {
  const state = resolveStudyRelationshipState(relationship);
  const width = Number(relationship.width.toFixed(2));
  const animated = motionEnabled && state === "live-transfer" && relationship.animated;
  const motionSeconds = Number((Math.max(2.8, 8.8 - Math.min(width, 6))).toFixed(2));
  return {
    state,
    animated,
    width,
    motionSeconds,
    direction: state === "live-transfer" ? relationship.direction : "none",
  };
}

function relationshipTouchesNode(relationship: FabricRelationship, nodeId: string): boolean {
  return relationship.fromNodeId === nodeId || relationship.toNodeId === nodeId;
}

function routeTouchesNode(route: FabricLogicalRoute, nodeId: string): boolean {
  return route.fromNodeId === nodeId || route.toNodeId === nodeId;
}

function relationshipPeerLabel(model: FabricModel, relationship: FabricRelationship, selectedId: string): string {
  const peerId = relationship.fromNodeId === selectedId ? relationship.toNodeId : relationship.fromNodeId;
  return model.nodes.find((node) => node.id === peerId)?.label ?? peerId.replace(/^.*:/, "");
}

function focusSummaryFromScene(scene: FabricCompositionScene, selectedId: string): FocusSummary | null {
  const metadata = (scene as FabricCompositionScene & {
    metadata?: {
      focusSummaryByNodeId?: SceneFocusMetadata;
      focusSummary?: SceneFocusMetadata;
    };
  }).metadata;
  const entry = metadata?.focusSummaryByNodeId?.[selectedId] ?? metadata?.focusSummary?.[selectedId];
  if (!entry?.summary && !entry?.connectivity && !entry?.peers?.length) return null;
  return {
    summary: entry.summary ?? "Focused view available from composition metadata.",
    connectivity: entry.connectivity ?? "Connectivity metadata available.",
    peers: entry.peers ?? [],
  };
}

function buildFallbackFocusSummary(
  scene: FabricCompositionScene,
  model: FabricModel,
  selectedId: string,
): FocusSummary {
  const group = model.population.groups.find((candidate) => candidate.id === selectedId);
  const physicalFocus = scene.subsystemFocus.byNodeId[selectedId];
  const relationships = model.relationships.filter((relationship) => relationshipTouchesNode(relationship, selectedId));
  const routeCount = scene.logicalRoutes.filter((route) => routeTouchesNode(route, selectedId)).length;
  const planeCounts = relationships.reduce<Record<string, number>>((result, relationship) => {
    const key = relationship.plane === "control" ? "control" : relationship.evidence === "state-only" ? "state" : "data";
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  const connectivity = [
    physicalFocus?.networkSegmentIds.length
      ? `${physicalFocus.networkSegmentIds.length} network membership${physicalFocus.networkSegmentIds.length === 1 ? "" : "s"}`
      : null,
    physicalFocus && physicalFocus.coverage.read === "unknown" && physicalFocus.coverage.write === "unknown"
      ? "storage capability unknown"
      : physicalFocus?.storageSegmentIds.length
        ? `${physicalFocus.storageSegmentIds.length} storage branch${physicalFocus.storageSegmentIds.length === 1 ? "" : "es"}`
        : null,
    planeCounts.control ? `${planeCounts.control} declared control` : null,
    planeCounts.state ? `${planeCounts.state} state-only` : null,
    planeCounts.data ? `${planeCounts.data} transfer path${planeCounts.data === 1 ? "" : "s"}` : null,
    routeCount ? `${routeCount} routed segment set${routeCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ") || "No direct connectivity surfaced.";
  const summary = group
    ? `${group.members.length} named members; ${relationships.length} direct relationships surfaced for the subsystem.`
    : `${relationships.length} direct relationships surfaced for the focused node.`;
  const peers = relationships
    .map((relationship) => `${relationshipPeerLabel(model, relationship, selectedId)} · ${relationship.basis ?? relationship.evidence} · ${compactRate(relationship.rateBytesPerSecond)}`)
    .concat(physicalFocus?.networkSegmentIds.map((networkId) => `${networkId.replace(/^network:/, "")} · Docker membership`) ?? [])
    .slice(0, 4);
  return { summary, connectivity, peers };
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
  const highlightedFraction = Math.max(0, Math.min(1, selectedContribution?.fraction ?? 0));
  const scaledWidth = (fraction: number) => Number((width * Math.max(0, Math.min(1, fraction))).toFixed(6));
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
            style={{ opacity: 0.14 + Math.max(0, Math.min(1, fraction)) * 0.56 }}
          />
        ))}
        {selectedContribution ? (
          <rect
            x={x}
            y={bounds.y + 72}
            width={scaledWidth(highlightedFraction)}
            height="2.5"
            rx="1.25"
            className="fabric-study-resource-selected"
          />
        ) : null}
      </g>
    );
  }
  const fractions = view.id === "gpu" ? view.segments.slice(0, 2) : [view.fraction ?? view.segments[0] ?? 0];
  return (
    <g className="fabric-study-resource-graphic" aria-hidden="true">
      {fractions.map((fraction, index) => (
        <g key={index}>
          <rect x={x} y={bounds.y + 50 + index * 13} width={width} height="5" rx="2.5" className="fabric-study-resource-track" />
          <rect x={x} y={bounds.y + 50 + index * 13} width={scaledWidth(fraction)} height="5" rx="2.5" />
        </g>
      ))}
      {selectedContribution && view.id === "memory" ? (
        <rect
          x={x}
          y={bounds.y + 70}
          width={scaledWidth(highlightedFraction)}
          height="3"
          rx="1.5"
          className="fabric-study-resource-selected"
        />
      ) : null}
    </g>
  );
}

function NodeCard({
  node,
  modelKind,
  selected,
  related,
  selectedContribution,
  visiblePortIds,
  suppressSecondary,
  onSelect,
}: {
  node: FabricCompositionNode;
  modelKind: string;
  selected: boolean;
  related: boolean;
  selectedContribution: FabricResourceContribution | null;
  visiblePortIds: Set<string>;
  suppressSecondary: boolean;
  onSelect: (trigger: SVGGElement) => void;
}) {
  const { bounds } = node;
  const status = statusSymbol[node.status];
  const micro = bounds.height < 42;
  const subsystem = node.role === "subsystem";
  const resource = node.role === "resource";
  const storage = node.role === "storage";
  const metricY = bounds.y + (subsystem ? 53 : storage ? bounds.height - 16 : Math.min(60, bounds.height - 12));
  const statusY = bounds.y + (subsystem ? 14 : bounds.height / 2);
  const metricWidth = Math.max(66, (bounds.width - 24) / Math.max(1, Math.min(2, node.metrics.length)));
  const showSecondary = selected || related || !suppressSecondary;
  const visiblePorts = node.ports.filter((port) => selected || visiblePortIds.has(port.id));
  return (
    <g
      data-study-node={node.sourceNodeId}
      data-fabric-node={node.sourceNodeId}
      data-fabric-node-kind={modelKind}
      data-study-node-role={node.role}
      data-study-node-bounds={`${bounds.x},${bounds.y},${bounds.width},${bounds.height}`}
      data-study-member-ids={node.memberIds.join(",")}
      data-study-promoted-count={node.promoted.length}
      data-study-node-detail={showSecondary ? "full" : "quiet"}
      className={`fabric-study-node fabric-study-node-${node.role}${selected ? " is-selected" : ""}${related ? " is-related" : ""}${!related && !selected ? " is-subdued" : ""}`}
      role={node.kind === "fabric" ? undefined : "button"}
      tabIndex={node.kind === "fabric" ? undefined : 0}
      aria-label={`${node.label}; ${node.status}; ${node.metrics.map((metric) => `${metric.label} ${metric.value}`).join(", ")}`}
      onClick={node.kind === "fabric" ? undefined : (event) => onSelect(event.currentTarget)}
      onKeyDown={node.kind === "fabric" ? undefined : (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(event.currentTarget);
        }
      }}
    >
      <rect data-study-node-box {...bounds} rx={resource ? 7 : node.role === "data-plane" ? 14 : 9} className="fabric-study-card" />
      {!micro && !storage ? (
        <text
          data-study-essential-text
          data-study-text-role="tertiary"
          data-owner-node={node.sourceNodeId}
          x={bounds.x + 12}
          y={bounds.y + (subsystem ? 14 : 18)}
          className="fabric-study-eyebrow"
        >
          {node.eyebrow}
        </text>
      ) : null}
      <text
        data-study-essential-text
        data-study-text-role="title"
        data-owner-node={node.sourceNodeId}
        x={bounds.x + 12}
        y={bounds.y + (micro ? bounds.height / 2 + 5 : subsystem ? 34 : storage ? 31 : 39)}
        className="fabric-study-title fabric-title"
      >
        {node.label}
      </text>
      {resource ? <ResourceGraphic node={node} selectedContribution={selectedContribution} /> : null}
      {!micro && !resource && (!subsystem || bounds.height >= 55) ? node.metrics.slice(0, showSecondary ? 2 : 1).map((metric, index) => (
        <text
          key={`${metric.label}-${index}`}
          data-study-essential-text
          data-study-text-role="secondary"
          data-owner-node={node.sourceNodeId}
          x={bounds.x + 12 + index * metricWidth}
          y={metricY}
          className="fabric-study-metric"
        >
          {metric.value}<tspan dx="4" className="fabric-study-metric-label">{metric.label}</tspan>
        </text>
      )) : null}
      {resource && node.resourceView ? (
        <text
          data-study-essential-text
          data-study-text-role="secondary"
          data-owner-node={node.sourceNodeId}
          x={bounds.x + bounds.width - 12}
          y={bounds.y + 37}
          textAnchor="end"
          className="fabric-study-metric"
        >
          {selectedContribution
            ? `${selectedContribution.coverage === "partial" ? "≈" : ""}${selectedContribution.value === null ? "—" : node.resourceView.id === "cpu" ? `${selectedContribution.value.toFixed(2)}c` : `${(selectedFraction(selectedContribution) * 100).toFixed(1)}%`} selected`
            : node.resourceView.primary}
        </text>
      ) : null}
      {showSecondary ? node.promoted.slice(0, 1).map((name) => (
        <text
          key={name}
          data-study-essential-text
          data-study-text-role="secondary"
          data-study-promoted
          data-owner-node={node.sourceNodeId}
          x={bounds.x + bounds.width - 12}
          y={bounds.y + (subsystem ? 34 : 39)}
          textAnchor="end"
          className="fabric-study-promoted"
        >
          {name}
        </text>
      )) : null}
      {status && !micro ? (
        <g aria-hidden="true">
          <circle cx={bounds.x + bounds.width - 12} cy={statusY} r="7" className="fabric-study-status" />
          <text
            data-study-essential-text
            data-study-text-role="status"
            data-owner-node={node.sourceNodeId}
            x={bounds.x + bounds.width - 12}
            y={statusY + 3}
            textAnchor="middle"
            className="fabric-study-status-text"
          >
            {status}
          </text>
        </g>
      ) : null}
      {visiblePorts.map((port) => (
        <g
          key={port.id}
          data-study-port-id={port.id}
          data-fabric-port={port.id}
          data-fabric-port-node={node.sourceNodeId}
          data-fabric-port-kind={port.kind}
          data-study-port-kind={port.kind}
          data-study-port-center={`${port.center.x},${port.center.y}`}
          aria-hidden="true"
        >
          <circle cx={port.center.x} cy={port.center.y} r="3.8" className={`fabric-study-port fabric-study-port-${port.kind}`} />
          <circle cx={port.center.x} cy={port.center.y} r="1.15" className="fabric-study-port-core" />
        </g>
      ))}
    </g>
  );
}

function Segment({ segment, presentation }: { segment: FabricPhysicalSegment; presentation: SegmentPresentation }) {
  if (!presentation.visible) return null;
  const d = pathData(segment);
  const motionDirection = presentation.direction === "reverse" ? "reverse" : "normal";
  return (
    <g
      data-study-segment-group={segment.id}
      data-study-segment-plane={segment.plane}
      data-study-segment-activity={presentation.state}
      data-study-segment-motion={presentation.animated ? "directional" : "static"}
      className={`fabric-study-segment-group ${presentation.structural ? "is-structural" : "is-branch"}${presentation.active ? " is-active" : ""}${presentation.focused ? " is-focused" : ""}`}
    >
      <path d={d} className={`fabric-study-substrate fabric-study-substrate-${segment.plane}`} />
      <path
        d={d}
        data-study-segment={segment.id}
        data-fabric-route={presentation.active ? segment.id : undefined}
        data-fabric-flow-motion={presentation.animated ? "true" : undefined}
        data-direction={presentation.direction}
        data-study-points={segment.points.map((point) => `${point.x},${point.y}`).join(";")}
        data-study-endpoint-a={segment.endpointIds[0]}
        data-study-endpoint-b={segment.endpointIds[1]}
        data-study-junction-ids={segment.junctionIds.join(",")}
        data-study-logical-contributors={segment.logicalContributorIds.join(",")}
        data-study-directions={presentation.direction === "none" ? "" : segment.directions.join(",")}
        className={`fabric-study-channel fabric-study-channel-${segment.plane} fabric-study-channel-activity-${presentation.state}`}
        style={{
          strokeWidth: presentation.width,
          animationDuration: `${presentation.motionSeconds}s`,
          animationDirection: motionDirection,
        }}
      />
      {segment.label && presentation.showLabel ? (
        <g
          data-study-segment-label={segment.id}
          data-study-label-bounds={`${segment.labelBounds.x},${segment.labelBounds.y},${segment.labelBounds.width},${segment.labelBounds.height}`}
        >
          <rect {...segment.labelBounds} rx="4" className="fabric-study-label-backdrop" />
          <text data-study-essential-text data-study-text-role="substrate" x={segment.labelBounds.x + 6} y={segment.labelBounds.y + 11} className="fabric-study-segment-label">
            {segment.label}
          </text>
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
      data-study-junction-region={junction.region ?? ""}
      data-study-junction-crossing-pairs={junction.crossingPairIds?.join("|") ?? ""}
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const node = scene.nodes.find((candidate) => candidate.sourceNodeId === selectedId);
  if (!node) return null;
  const group = model.population.groups.find((candidate) => candidate.id === selectedId);
  const relationships = model.relationships.filter((relationship) => relationshipTouchesNode(relationship, selectedId));
  const focusSummary = focusSummaryFromScene(scene, selectedId) ?? buildFallbackFocusSummary(scene, model, selectedId);
  return (
    <>
    <aside data-study-inspector data-fabric-inspector className="fabric-study-inspector" aria-label={`${node.label} inspector`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Composition inspector</p>
          <h2 className="mt-1 truncate text-sm font-medium text-fg">{node.label}</h2>
          <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted">{node.role} · {node.status}</p>
        </div>
        <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline text-muted hover:border-border hover:text-fg" aria-label="Close composition inspector">×</button>
      </div>
      <section data-study-focus-summary className="mt-4 rounded-xl border border-hairline/70 bg-surface/28 px-3 py-3">
        <p className="text-[9px] uppercase tracking-[0.14em] text-faint">Focus summary</p>
        <p className="mt-2 text-[11px] leading-5 text-muted">{focusSummary.summary}</p>
        <p data-study-focus-connectivity className="mt-2 text-[10px] uppercase tracking-[0.1em] text-faint">{focusSummary.connectivity}</p>
        {focusSummary.peers.length ? (
          <ul className="mt-2 space-y-1 text-[10px] text-muted">
            {focusSummary.peers.map((peer) => <li key={peer}>{peer}</li>)}
          </ul>
        ) : null}
      </section>
      {node.metrics.length ? (
        <dl data-study-inspector-metrics className="mt-4 grid grid-cols-2 gap-2">
          {node.metrics.slice(0, 3).map((metric) => (
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
          <ul data-study-inspector-relationships aria-label="Relevant relationships" className="mt-2 divide-y divide-hairline/60">
            {relationships.slice(0, 5).map((relationship) => (
              <li key={relationship.id} className="py-2 text-[11px] text-muted">
                <span className="block truncate">{relationship.label}</span>
                <span className="mt-1 block text-[9px] uppercase tracking-[0.1em] text-faint">
                  {relationship.basis ?? relationship.evidence} · {resolveStudyRelationshipState(relationship)} · {relationship.plane}
                </span>
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
      <button
        type="button"
        onClick={() => setDetailsOpen(true)}
        className="mt-4 w-full rounded-lg border border-hairline px-3 py-2 text-[10px] uppercase tracking-[0.13em] text-muted hover:border-border hover:text-fg"
      >
        Technical details
      </button>
    </aside>
    <DrawerShell
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      title="Fabric technical details"
      closeLabel="Close technical details"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <section>
          <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Entity</p>
          <h3 className="mt-1 text-base text-fg">{node.label}</h3>
          <p className="mt-2 text-sm text-muted">{node.role} · {node.status}</p>
        </section>
        {group ? (
          <section className="mt-6">
            <h4 className="text-[10px] uppercase tracking-[0.14em] text-faint">Complete workload population · {group.members.length}</h4>
            <ul className="mt-2 divide-y divide-hairline/60">
              {group.members.map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                  <span className="truncate text-muted">{member.name}</span>
                  <span className={member.attention ? "shrink-0 text-warn" : "shrink-0 text-faint"}>
                    {member.attention ? "attention" : member.state}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="mt-6">
          <h4 className="text-[10px] uppercase tracking-[0.14em] text-faint">Evidence and attribution</h4>
          <div className="mt-2 space-y-3">
            {relationships.length ? relationships.map((relationship) => (
              <article key={relationship.id} className="rounded-lg border border-hairline p-3">
                <div className="flex items-center justify-between gap-3">
                  <h5 className="text-xs text-fg">{relationship.label}</h5>
                  <span className="text-[9px] uppercase tracking-[0.12em] text-faint">{relationship.evidence}</span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div><dt className="text-faint">Freshness</dt><dd className="text-muted">{relationship.freshness}</dd></div>
                  <div><dt className="text-faint">Coverage</dt><dd className="text-muted">{relationship.coverage}</dd></div>
                  <div><dt className="text-faint">Basis</dt><dd className="text-muted">{relationship.basis ?? "not available"}</dd></div>
                  <div><dt className="text-faint">Rate</dt><dd className="text-muted">{compactRate(relationship.rateBytesPerSecond)}</dd></div>
                </dl>
                <p className="mt-3 text-xs leading-5 text-muted">{relationship.provenance}</p>
                {relationship.attribution ? <p className="mt-2 text-xs leading-5 text-faint">{relationship.attribution}</p> : null}
              </article>
            )) : <p className="text-sm text-muted">No active or declared pairwise relationship for this entity.</p>}
          </div>
        </section>
      </div>
    </DrawerShell>
    </>
  );
}

function normalizeFocus(initialFocus: string | null): string | null {
  if (!initialFocus) return null;
  return initialFocus.startsWith("service:") || initialFocus.startsWith("group:") || initialFocus.startsWith("pool:")
    ? initialFocus
    : `service:${initialFocus}`;
}

function compactCompositionMetric(value: string): string {
  return value.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").replace(/\bTB\b/g, "T").replace(/\bGB\b/g, "G").replace(/\bMB\b/g, "M");
}

function compactCompositionLabel(value: string, limit = 18): string {
  const normalized = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function refreshedPromotedMembers(model: FabricModel, nodeId: string): string[] {
  const group = model.population.groups.find((candidate) => candidate.id === nodeId);
  if (!group) return [];
  const active = group.members.filter((member) =>
    member.attention ||
    (member.cpuFraction ?? 0) >= 0.25 ||
    (member.netRxBps ?? 0) >= 1_000_000 ||
    (member.netTxBps ?? 0) >= 1_000_000 ||
    (member.blockReadBps ?? 0) >= 1_000_000 ||
    (member.blockWriteBps ?? 0) >= 1_000_000,
  );
  return (active.length ? active : group.members.slice(0, 1))
    .slice(0, 2)
    .map((member) => compactCompositionLabel(member.name));
}

function refreshFabricComposition(scene: FabricCompositionScene, model: FabricModel): FabricCompositionScene {
  const sourceNodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const resourceViewByNodeId = new Map(model.resourceViews.map((view) => [view.nodeId, view]));
  const accountedNodeById = new Map(model.population.accountedNodes.map((node) => [node.nodeId, node]));
  const relationshipById = new Map(model.relationships.map((relationship) => [relationship.id, relationship]));
  const capabilityByNodeId = new Map(model.stableCapabilities.map((capability) => [capability.nodeId, capability]));

  const nodes = scene.nodes.map((node) => {
    const source = sourceNodeById.get(node.sourceNodeId);
    if (!source) return node;
    const metrics = node.role === "storage" && source.metrics.length >= 2
      ? [{ label: "CAP · USED", value: `${compactCompositionMetric(source.metrics[0]!.value)} · ${source.metrics[1]!.value}` }]
      : source.metrics
        .slice(0, node.role === "subsystem" ? 3 : 2)
        .map((metric) => ({ ...metric, value: compactCompositionMetric(metric.value) }));
    return {
      ...node,
      status: source.status,
      metrics,
      promoted: refreshedPromotedMembers(model, node.sourceNodeId),
      resourceView: resourceViewByNodeId.get(node.sourceNodeId) ?? null,
    };
  });

  const logicalRoutes = scene.logicalRoutes.map((route) => {
    const relationship = relationshipById.get(route.contributorRelationshipId) ?? relationshipById.get(route.relationshipId);
    return relationship ? {
      ...route,
      label: relationship.label,
      direction: relationship.direction,
      evidence: relationship.evidence,
      networkBoundary: relationship.networkBoundary,
    } : route;
  });
  const segments = scene.segments.map((segment) => {
    const directions = new Set<"forward" | "reverse">();
    for (const contributorId of segment.logicalContributorIds) {
      const relationship = relationshipById.get(contributorId);
      if (!relationship) continue;
      if (relationship.direction !== "reverse") directions.add("forward");
      if (relationship.direction !== "forward") directions.add("reverse");
    }
    return { ...segment, directions: [...directions] };
  });
  const byNodeId = Object.fromEntries(Object.entries(scene.subsystemFocus.byNodeId).map(([nodeId, focus]) => {
    const capability = capabilityByNodeId.get(nodeId);
    if (!capability) return [nodeId, focus];
    return [nodeId, {
      ...focus,
      memberIds: accountedNodeById.get(nodeId)?.containerIds ?? [],
      networkSegmentIds: capability.networkSegmentIds,
      coverage: {
        network: capability.coverage.network,
        read: capability.coverage.read,
        write: capability.coverage.write,
      },
    }];
  }));

  return {
    ...scene,
    nodes,
    segments,
    logicalRoutes,
    representedIds: [...model.population.ids].sort(),
    summaryIds: [...new Set(model.population.accountedNodes.flatMap((node) => node.containerIds))].sort(),
    subsystemFocus: { ...scene.subsystemFocus, byNodeId },
  };
}

function FabricCompositionView({
  model,
  geometryModel,
  study = "A+",
  viewMode,
  quiet,
  initialFocus = null,
  motionEnabled,
  topologyState = "live",
  surfaceLabel = "Server fabric",
}: {
  model: FabricModel;
  geometryModel?: FabricModel;
  study?: FabricCompositionId;
  viewMode: FabricCompositionViewMode;
  quiet: boolean;
  initialFocus?: string | null;
  motionEnabled: boolean;
  topologyState?: FabricTopologyState;
  surfaceLabel?: string;
}) {
  const mapMode = viewMode === "relationship-map";
  const compositionModel = geometryModel ?? model;
  const geometryScene = useMemo(() => buildFabricComposition(compositionModel, study), [compositionModel, study]);
  const scene = useMemo(() => refreshFabricComposition(geometryScene, model), [geometryScene, model]);
  const normalizedFocus = normalizeFocus(initialFocus);
  const [selectedId, setSelectedId] = useState(normalizedFocus);
  useEffect(() => setSelectedId(normalizedFocus), [normalizedFocus]);
  const lastTriggerRef = useRef<SVGGElement | null>(null);

  const closeSelection = () => {
    setSelectedId(null);
    lastTriggerRef.current?.focus();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !selectedId) return;
      event.preventDefault();
      closeSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  const relationshipPresentationById = useMemo(
    () => new Map(model.relationships.map((relationship) => [relationship.id, relationshipPresentation(relationship, motionEnabled)])),
    [model.relationships, motionEnabled],
  );

  const focusedRelationshipIds = useMemo(() => new Set(
    selectedId
      ? model.relationships
        .filter((relationship) =>
          relationshipTouchesNode(relationship, selectedId) &&
          (!mapMode || relationship.visibility === "focus" || relationship.plane === "control"),
        )
        .map((relationship) => relationship.id)
      : [],
  ), [mapMode, model.relationships, selectedId]);

  const visibleRelationshipIds = useMemo(() => {
    const visible = new Set<string>();
    for (const relationship of model.relationships) {
      const allowedInMode = mapMode
        ? relationship.visibility === "focus" || relationship.plane === "control"
        : selectedId !== null || relationship.visibility === "active";
      if (selectedId) {
        if (allowedInMode && relationshipTouchesNode(relationship, selectedId)) visible.add(relationship.id);
      } else if (allowedInMode) {
        visible.add(relationship.id);
      }
    }
    return visible;
  }, [mapMode, model.relationships, selectedId]);

  const visibleRouteIds = useMemo(() => new Set(
    scene.logicalRoutes
      .filter((route) =>
        visibleRelationshipIds.has(route.relationshipId) ||
        visibleRelationshipIds.has(route.contributorRelationshipId) ||
        (selectedId && !mapMode ? routeTouchesNode(route, selectedId) : false),
      )
      .map((route) => route.relationshipId),
  ), [mapMode, scene.logicalRoutes, selectedId, visibleRelationshipIds]);

  const dominantDataActivity = useMemo<StudyRelationshipActivityState>(() => {
    const presentations = model.relationships
      .filter((relationship) => relationship.plane === "data" && visibleRelationshipIds.has(relationship.id))
      .map((relationship) => relationshipPresentation(relationship, motionEnabled));
    return ACTIVITY_PRIORITY.find((candidate) => presentations.some((presentation) => presentation.state === candidate))
      ?? "dormant-structural";
  }, [model.relationships, motionEnabled, visibleRelationshipIds]);

  const focusedRouteIds = useMemo(() => new Set(
    scene.logicalRoutes
      .filter((route) =>
        focusedRelationshipIds.has(route.relationshipId) ||
        focusedRelationshipIds.has(route.contributorRelationshipId) ||
        (selectedId && !mapMode ? routeTouchesNode(route, selectedId) : false),
      )
      .map((route) => route.relationshipId),
  ), [focusedRelationshipIds, mapMode, scene.logicalRoutes, selectedId]);

  const relatedNodeIds = useMemo(() => {
    const result = new Set<string>();
    if (selectedId) result.add(selectedId);
    for (const relationship of model.relationships) {
      if (!selectedId) {
        if (visibleRelationshipIds.has(relationship.id)) {
          result.add(relationship.fromNodeId);
          result.add(relationship.toNodeId);
        }
        continue;
      }
      if (relationshipTouchesNode(relationship, selectedId) && (!mapMode || visibleRelationshipIds.has(relationship.id))) {
        result.add(relationship.fromNodeId);
        result.add(relationship.toNodeId);
      }
    }
    return result;
  }, [mapMode, model.relationships, selectedId, visibleRelationshipIds]);

  const visiblePortIds = useMemo(() => {
    const result = new Set<string>();
    for (const route of scene.logicalRoutes) {
      if (!visibleRouteIds.has(route.relationshipId) && !focusedRouteIds.has(route.relationshipId)) continue;
      if (route.resolution !== "complete" || route.segmentIds.length === 0) continue;
      result.add(route.fromPortId);
      result.add(route.toPortId);
    }
    if (selectedId) {
      for (const node of scene.nodes) {
        if (node.sourceNodeId !== selectedId) continue;
        node.ports.forEach((port) => result.add(port.id));
      }
    }
    return result;
  }, [focusedRouteIds, scene.logicalRoutes, scene.nodes, selectedId, visibleRouteIds]);

  const focusedNetworkRailIds = useMemo(() => new Set(
    selectedId
      ? (scene.subsystemFocus.byNodeId[selectedId]?.networkSegmentIds ?? [])
        .map((networkSegmentId) => `segment:a-plus:${networkSegmentId}:rail`)
      : [],
  ), [scene.subsystemFocus.byNodeId, selectedId]);

  const segmentPresentationById = useMemo(() => {
    const result = new Map<string, SegmentPresentation>();
    for (const segment of scene.segments) {
      const structural = isStructuralSegment(segment);
      const segmentRoutes = scene.logicalRoutes.filter((route) => route.segmentIds.includes(segment.id));
      const visibleRoutePresentations = segmentRoutes
        .filter((route) => visibleRouteIds.has(route.relationshipId))
        .map((route) => relationshipPresentationById.get(route.contributorRelationshipId) ?? relationshipPresentationById.get(route.relationshipId))
        .filter((entry): entry is RelationshipPresentation => Boolean(entry));
      const focused = segmentRoutes.some((route) => focusedRouteIds.has(route.relationshipId)) || Boolean(
        selectedId && (
          focusedNetworkRailIds.has(segment.id) ||
          segment.subsystemFocus?.nodeIds.includes(selectedId) ||
          segment.endpointIds.some((endpointId) => endpointId.startsWith(`${selectedId}:`))
        ),
      );
      const active = visibleRoutePresentations.length > 0;
      const state = active
        ? ACTIVITY_PRIORITY.find((candidate) => visibleRoutePresentations.some((presentation) => presentation.state === candidate)) ?? "dormant-structural"
        : "dormant-structural";
      const width = Number((active ? Math.max(...visibleRoutePresentations.map((presentation) => presentation.width)) : structural ? 1.15 : 0.8).toFixed(2));
      const motionSeconds = active ? Math.min(...visibleRoutePresentations.map((presentation) => presentation.motionSeconds)) : 8;
      const animatedPresentation = visibleRoutePresentations.find((presentation) => presentation.animated);
      const visible = isPrincipalQuietSegment(segment) || active || focused;
      const showLabel = structural || active || focused;
      result.set(segment.id, {
        visible,
        focused,
        active,
        structural,
        // Continuous stroke-dashoffset on board-scale SVG paths forces a
        // persistent repaint. Keep direction available as route metadata while
        // the ambient surface remains scheduler-free.
        animated: false,
        state,
        width,
        motionSeconds,
        direction: animatedPresentation?.direction ?? "none",
        showLabel,
      });
    }
    return result;
  }, [focusedNetworkRailIds, focusedRouteIds, relationshipPresentationById, scene.logicalRoutes, scene.segments, selectedId, visibleRouteIds]);

  const visibleJunctionIds = useMemo(() => {
    const result = new Set<string>();
    for (const segment of scene.segments) {
      const presentation = segmentPresentationById.get(segment.id);
      if (!presentation?.visible || (!presentation.active && !presentation.focused)) continue;
      segment.junctionIds.forEach((junctionId) => result.add(junctionId));
    }
    return result;
  }, [scene.segments, segmentPresentationById]);

  return (
    <main
      data-fabric-mount
      data-ui-mode="fabric"
      data-fabric-topology={topologyState}
      data-motion={motionEnabled ? "on" : "off"}
      data-study-shell
      data-study-id={scene.id}
      data-study-mode={mapMode ? "map" : quiet ? "quiet" : "activity"}
      data-study-view-mode={viewMode}
      data-study-rendered-activity={dominantDataActivity}
      data-study-activity-scope="data-plane"
      data-study-inspector-open={selectedId ? "true" : "false"}
      className="fabric-study-shell fabric-ground"
    >
      <ul className="sr-only" aria-label="Visible fabric relationships">
        {model.relationships
          .filter((relationship) => visibleRelationshipIds.has(relationship.id))
          .map((relationship) => (
            <li key={relationship.id}>
              {relationship.label}; {resolveStudyRelationshipState(relationship)}; {relationship.direction}; {relationship.freshness}; {compactRate(relationship.rateBytesPerSecond)}
            </li>
          ))}
      </ul>
      <section data-study-stage-frame className="fabric-study-stage-frame" aria-label={scene.title}>
        <div className="fabric-study-heading">
          <div>
            <p>{mapMode ? "Declared relationship map" : surfaceLabel}</p>
            <h1>{scene.title}</h1>
          </div>
          <p className="fabric-study-thesis">{mapMode ? "Configured and declared control relationships over the existing substrate." : scene.thesis}</p>
        </div>
        <svg
          data-study-stage
          data-fabric-stage
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
          aria-label={`${surfaceLabel}; ${scene.representedIds.length} workloads represented by named workloads and subsystem summaries`}
        >
          <text x="24" y="20" className="fabric-study-region-label">
            {mapMode ? "DECLARED RELATIONSHIPS · CONTROL / DEPENDENCY VIEW" : "HARDWARE ACCOUNTING · RESOURCE PLANE · NO ROUTES"}
          </text>
          <g aria-hidden="true">
            {scene.logicalRoutes.map((route) => {
              const presentation = relationshipPresentationById.get(route.contributorRelationshipId) ?? relationshipPresentationById.get(route.relationshipId);
              return (
                <g
                  key={route.relationshipId}
                  data-study-logical-route={route.relationshipId}
                  data-study-route-from={route.fromNodeId}
                  data-study-route-to={route.toNodeId}
                  data-study-route-from-port={route.fromPortId}
                  data-study-route-to-port={route.toPortId}
                  data-study-route-contributor={route.contributorRelationshipId}
                  data-study-route-plane={route.plane}
                  data-study-route-segments={route.segmentIds.join(",")}
                  data-study-route-activity={presentation?.state ?? "dormant-structural"}
                  data-study-route-motion={presentation?.animated ? "directional" : "static"}
                  data-study-route-visible={visibleRouteIds.has(route.relationshipId) ? "true" : "false"}
                  data-study-route-resolution={route.resolution}
                />
              );
            })}
            {scene.primaryStorageCorridors.map((corridor) => (
              <g
                key={corridor.nodeId}
                data-study-storage-corridor={corridor.nodeId}
                data-study-corridor-bounds={`${corridor.bounds.x},${corridor.bounds.y},${corridor.bounds.width},${corridor.bounds.height}`}
              />
            ))}
          </g>
          <g aria-label="Planar physical segment graph">
            {scene.segments.map((segment) => (
              <Segment
                key={segment.id}
                segment={segment}
                presentation={segmentPresentationById.get(segment.id) ?? {
                  visible: false,
                  focused: false,
                  active: false,
                  structural: isStructuralSegment(segment),
                  animated: false,
                  state: "dormant-structural",
                  width: 0.8,
                  motionSeconds: 8,
                  direction: "none",
                  showLabel: false,
                }}
              />
            ))}
          </g>
          <g aria-label="Physical junction and via geometry">
            {scene.junctions
              .filter((junction) => visibleJunctionIds.has(junction.id))
              .map((junction) => <Junction key={junction.id} junction={junction} />)}
          </g>
          <g aria-label="Fabric composition nodes">
            {scene.nodes.map((node) => {
              const selected = selectedId === node.sourceNodeId;
              const related = selectedId
                ? relatedNodeIds.has(node.sourceNodeId) || node.role === "resource"
                : !mapMode || relatedNodeIds.has(node.sourceNodeId) || node.role === "resource";
              const suppressSecondary = (quiet || mapMode || Boolean(selectedId)) && !selected;
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  modelKind={model.nodes.find((candidate) => candidate.id === node.sourceNodeId)?.kind ?? node.kind}
                  selected={selected}
                  related={related}
                  selectedContribution={node.resourceView?.contributors?.find((contribution) => contribution.nodeId === selectedId) ?? null}
                  visiblePortIds={visiblePortIds}
                  suppressSecondary={suppressSecondary}
                  onSelect={(trigger) => {
                    lastTriggerRef.current = trigger;
                    setSelectedId((current) => current === node.sourceNodeId ? null : node.sourceNodeId);
                  }}
                />
              );
            })}
          </g>
        </svg>
      </section>
      {selectedId ? <Inspector scene={scene} model={model} selectedId={selectedId} onClose={closeSelection} /> : null}
    </main>
  );
}

export const FabricComposition = memo(FabricCompositionView);
FabricComposition.displayName = "FabricComposition";
