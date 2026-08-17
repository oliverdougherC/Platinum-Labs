import type { FabricBounds } from "@/lib/fabric/layout";

export type FabricPortKind = "network" | "control" | "read" | "write";
export type FabricPortSide = "top" | "right" | "bottom" | "left";

export interface FabricPortSpec {
  id: string;
  nodeId: string;
  kind: FabricPortKind;
  side: FabricPortSide;
  /** 0..1 position along the selected side. */
  offset: number;
  label: string;
}

export interface FabricPort extends FabricPortSpec {
  center: { x: number; y: number };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Single source of truth for connector geometry. Renderers and routers both
 * consume this exact object; neither is permitted to recreate the coordinates.
 */
export function materializePort(spec: FabricPortSpec, bounds: FabricBounds): FabricPort {
  const t = clamp01(spec.offset);
  let x = bounds.x;
  let y = bounds.y;
  if (spec.side === "top" || spec.side === "bottom") {
    x += bounds.width * t;
    y += spec.side === "bottom" ? bounds.height : 0;
  } else {
    x += spec.side === "right" ? bounds.width : 0;
    y += bounds.height * t;
  }
  return {
    ...spec,
    offset: t,
    center: {
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
    },
  };
}

export function portMap(ports: FabricPort[]): Map<string, FabricPort> {
  return new Map(ports.map((port) => [port.id, port]));
}
