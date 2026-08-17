"use client";

import { DrawerShell } from "@/components/ui/overlay-shell";
import type { FabricModel, FabricRelationship } from "@/lib/fabric/model";
import type { FabricSelection } from "@/components/fabric/fabric-stage";
import { formatBytes, formatRate } from "@/lib/format/bytes";

function RelationshipLine({ relationship }: { relationship: FabricRelationship }) {
  return (
    <li className="grid grid-cols-[1fr_auto] gap-3 border-t border-hairline/60 py-2 first:border-0">
      <span className="min-w-0 truncate text-[11px] text-muted">{relationship.label}</span>
      <span className="tnum text-[10px] uppercase tracking-[0.1em] text-faint">
        {relationship.plane === "control" ? "control" : relationship.rateBytesPerSecond === null ? "unknown" : formatRate(relationship.rateBytesPerSecond)}
      </span>
    </li>
  );
}
export function FabricInspector({
  model,
  selection,
  onClose,
  detailsOpen,
  onDetailsOpen,
  onDetailsClose,
}: {
  model: FabricModel;
  selection: FabricSelection | null;
  onClose: () => void;
  detailsOpen: boolean;
  onDetailsOpen: () => void;
  onDetailsClose: () => void;
}) {
  if (!selection) {
    return (
      <aside data-fabric-inspector-dock className="fabric-inspector-dock" aria-label="Inspector dock">
        <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Inspector</p>
        <p className="mt-2 max-w-[18ch] text-xs leading-5 text-muted">Select a workload, subsystem, pool, or active relationship.</p>
      </aside>
    );
  }
  const node = selection.kind === "node" ? model.nodes.find((item) => item.id === selection.id) : undefined;
  const selectedRelationship = selection.kind === "relationship" ? model.relationships.find((item) => item.id === selection.id) : undefined;
  const relationships = selectedRelationship
    ? [selectedRelationship]
    : model.relationships.filter((item) => item.fromNodeId === node?.id || item.toNodeId === node?.id).slice(0, 5);
  const group = node?.kind === "group" ? model.population.groups.find((item) => item.id === node.id) : undefined;
  const title = node?.label ?? selectedRelationship?.label ?? "Selection";
  const state = node && node.status !== "healthy" ? node.status.replace("-", " ") : selectedRelationship?.freshness !== "live" ? selectedRelationship?.freshness : null;
  const metrics = node?.metrics.slice(0, 3) ?? (selectedRelationship ? [
    { label: "plane", value: selectedRelationship.plane },
    { label: "rate", value: selectedRelationship.rateBytesPerSecond === null ? "Unknown" : formatRate(selectedRelationship.rateBytesPerSecond) },
    { label: "coverage", value: selectedRelationship.coverage },
  ] : []);

  return (
    <>
      <aside data-fabric-inspector data-fabric-inspector-dock className="fabric-inspector-dock fabric-inspector-active" aria-label={`${title} inspector`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.16em] text-faint">Inspector</p>
            <h2 className="mt-1 truncate text-sm font-medium text-fg">{title}</h2>
            {state ? <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-warn">{state}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline text-muted hover:border-border hover:text-fg" aria-label="Close fabric inspector">×</button>
        </div>
        {metrics.length ? (
          <dl className="mt-4 grid grid-cols-3 gap-2">
            {metrics.map((metric) => (
              <div key={metric.label} className="min-w-0 rounded-lg border border-hairline/70 bg-surface/35 px-2 py-2">
                <dt className="truncate text-[9px] uppercase tracking-[0.1em] text-faint">{metric.label}</dt>
                <dd className="tnum mt-1 truncate text-[11px] text-fg">{metric.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {relationships.length ? (
          <ul className="mt-3" aria-label="Relevant relationships">
            {relationships.slice(0, 5).map((relationship) => <RelationshipLine key={relationship.id} relationship={relationship} />)}
          </ul>
        ) : null}
        <button type="button" onClick={onDetailsOpen} className="mt-3 w-full rounded-lg border border-hairline px-3 py-2 text-[10px] uppercase tracking-[0.13em] text-muted hover:border-border hover:text-fg">Technical details</button>
      </aside>

      <DrawerShell open={detailsOpen} onClose={onDetailsClose} title="Fabric technical details" closeLabel="Close technical details">
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <section>
            <p className="text-[10px] uppercase tracking-[0.14em] text-faint">Entity</p>
            <h3 className="mt-1 text-base text-fg">{title}</h3>
            {node ? <p className="mt-2 text-sm text-muted">{node.kind} · {node.status}</p> : null}
          </section>
          {group ? (
            <section className="mt-6">
              <h4 className="text-[10px] uppercase tracking-[0.14em] text-faint">Complete workload population · {group.members.length}</h4>
              <ul className="mt-2 divide-y divide-hairline/60">
                {group.members.map((member) => (
                  <li key={member.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="truncate text-muted">{member.name}</span>
                    <span className={`tnum shrink-0 ${member.attention ? "text-warn" : "text-faint"}`}>
                      {member.attention ? "attention · " : ""}
                      {member.cpuFraction === null ? "CPU —" : `${member.cpuFraction.toFixed(2)}c`} · {member.memoryBytes === null ? "MEM —" : formatBytes(member.memoryBytes)}
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
                    <div><dt className="text-faint">Rate</dt><dd className="text-muted">{relationship.rateBytesPerSecond === null ? "unknown" : formatRate(relationship.rateBytesPerSecond)}</dd></div>
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
