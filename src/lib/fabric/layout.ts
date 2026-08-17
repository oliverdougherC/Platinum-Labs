/**
 * Deterministic V3 Fabric geometry.
 *
 * The board always renders in this normalized coordinate space. SVG scales the
 * complete viewBox as a unit, so node bounds, visible ports and relationship
 * endpoints cannot drift independently at different viewport sizes.
 */

export const FABRIC_VIEWBOX = { width: 1200, height: 640 } as const;

export interface FabricBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FabricLayoutSlot =
  | "external-wan"
  | "external-lan"
  | "external-overlay"
  | "host-gateway"
  | "network-segment"
  | "control-lane"
  | "storage-read-fabric"
  | "storage-write-fabric"
  | "cpu"
  | "memory"
  | "gpu"
  | "arc"
  | "service"
  | "pool"
  | "group";

const FIXED: Record<Exclude<FabricLayoutSlot, "service" | "pool" | "group">, FabricBounds> = {
  "external-wan": { x: 30, y: 184, width: 132, height: 30 },
  "external-lan": { x: 30, y: 224, width: 132, height: 30 },
  "external-overlay": { x: 30, y: 264, width: 132, height: 30 },
  "host-gateway": { x: 30, y: 312, width: 132, height: 58 },
  "network-segment": { x: 30, y: 376, width: 132, height: 24 },
  "control-lane": { x: 214, y: 444, width: 706, height: 18 },
  "storage-read-fabric": { x: 214, y: 476, width: 706, height: 16 },
  "storage-write-fabric": { x: 214, y: 500, width: 706, height: 16 },
  cpu: { x: 30, y: 50, width: 272, height: 104 },
  memory: { x: 314, y: 50, width: 188, height: 104 },
  gpu: { x: 514, y: 50, width: 244, height: 104 },
  arc: { x: 770, y: 50, width: 150, height: 104 },
};

const SERVICE_SLOTS: FabricBounds[] = [
  { x: 214, y: 176, width: 210, height: 62 },
  { x: 452, y: 176, width: 210, height: 62 },
  { x: 690, y: 176, width: 224, height: 62 },
  { x: 214, y: 266, width: 210, height: 62 },
  { x: 452, y: 266, width: 210, height: 62 },
];

const POOL_SLOTS: FabricBounds[] = [
  { x: 214, y: 544, width: 222, height: 64 },
  { x: 448, y: 544, width: 222, height: 64 },
  { x: 682, y: 544, width: 238, height: 64 },
];

const GROUP_SLOTS: FabricBounds[] = [
  { x: 214, y: 356, width: 155, height: 78 },
  { x: 397, y: 356, width: 155, height: 78 },
  { x: 580, y: 356, width: 155, height: 78 },
  { x: 763, y: 356, width: 155, height: 78 },
];

function indexed(slots: FabricBounds[], index: number): FabricBounds {
  return slots[Math.max(0, Math.min(slots.length - 1, index))]!;
}

export function boundsFor(slot: FabricLayoutSlot, index = 0): FabricBounds {
  if (slot === "service") return indexed(SERVICE_SLOTS, index);
  if (slot === "pool") return indexed(POOL_SLOTS, index);
  if (slot === "group") return indexed(GROUP_SLOTS, index);
  if (slot === "network-segment") {
    return { ...FIXED[slot], y: FIXED[slot].y + index * 30 };
  }
  return FIXED[slot];
}

export function centerOf(bounds: FabricBounds): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}
