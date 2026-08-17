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
  | "external-fabric"
  | "service-fabric"
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
  "external-fabric": { x: 42, y: 46, width: 1116, height: 34 },
  "service-fabric": { x: 326, y: 118, width: 542, height: 28 },
  "storage-read-fabric": { x: 858, y: 152, width: 22, height: 354 },
  "storage-write-fabric": { x: 892, y: 152, width: 22, height: 354 },
  cpu: { x: 42, y: 122, width: 248, height: 152 },
  memory: { x: 42, y: 290, width: 248, height: 104 },
  gpu: { x: 42, y: 410, width: 248, height: 96 },
  arc: { x: 938, y: 494, width: 220, height: 100 },
};

const SERVICE_SLOTS: FabricBounds[] = [
  { x: 326, y: 178, width: 160, height: 82 },
  { x: 502, y: 178, width: 160, height: 82 },
  { x: 678, y: 178, width: 160, height: 82 },
  { x: 326, y: 278, width: 160, height: 82 },
  { x: 502, y: 278, width: 160, height: 82 },
];

const POOL_SLOTS: FabricBounds[] = [
  { x: 938, y: 122, width: 220, height: 104 },
  { x: 938, y: 242, width: 220, height: 104 },
  { x: 938, y: 362, width: 220, height: 104 },
];

const GROUP_SLOTS: FabricBounds[] = [
  { x: 326, y: 392, width: 122, height: 202 },
  { x: 458, y: 392, width: 122, height: 202 },
  { x: 590, y: 392, width: 122, height: 202 },
  { x: 722, y: 392, width: 116, height: 202 },
];

function indexed(slots: FabricBounds[], index: number): FabricBounds {
  return slots[Math.max(0, Math.min(slots.length - 1, index))]!;
}

export function boundsFor(slot: FabricLayoutSlot, index = 0): FabricBounds {
  if (slot === "service") return indexed(SERVICE_SLOTS, index);
  if (slot === "pool") return indexed(POOL_SLOTS, index);
  if (slot === "group") return indexed(GROUP_SLOTS, index);
  return FIXED[slot];
}

export function centerOf(bounds: FabricBounds): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}
