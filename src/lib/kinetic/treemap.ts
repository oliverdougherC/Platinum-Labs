/**
 * Stable aspect-ratio-aware binary treemap used by the kinetic container field.
 *
 * Containers have one deterministic identity order, then a balanced topology
 * is planned by splitting nearest half of the initial weight along each
 * rectangle's longest side. A mounted field reuses that topology while live
 * weights move only its boundaries. Stable ordering avoids weight-rank
 * crossings, while balanced longest-side subdivision prevents pathological
 * full-field strips without allowing telemetry changes to flip the topology.
 * Together those choices give us four useful properties:
 * every positive item is represented, area is exactly proportional to raw
 * memory, and changing a weight moves existing boundaries continuously instead
 * of re-sorting the whole field on small rank crossings, with substantially
 * better rectangle aspect ratios at real homelab scale.
 */

export interface TreemapItem {
  id: string;
  weight: number;
}

export interface TreemapBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapRect extends TreemapBounds {
  id: string;
  weight: number;
}

interface RankedItem extends TreemapItem {
  rank: number;
}

interface TreemapPlanLeaf {
  kind: "leaf";
  id: string;
  weight: number;
}

interface TreemapPlanBranch {
  kind: "branch";
  splitWidth: boolean;
  weight: number;
  left: TreemapPlanNode;
  right: TreemapPlanNode;
}

type TreemapPlanNode = TreemapPlanLeaf | TreemapPlanBranch;

export interface TreemapPlan {
  idsKey: string;
  aspectRatio: number;
  root: TreemapPlanNode;
}

export interface PlannedTreemap {
  rects: TreemapRect[];
  plan: TreemapPlan | null;
}

function stableRank(id: string): number {
  // FNV-1a, kept unsigned so bit partitions are deterministic in every JS VM.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function positiveWeight(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function total(items: readonly RankedItem[]): number {
  return items.reduce((sum, item) => sum + item.weight, 0);
}

function splitRect(
  bounds: TreemapBounds,
  ratio: number,
  splitWidth: boolean,
): [TreemapBounds, TreemapBounds] {
  const clamped = Math.min(1, Math.max(0, ratio));
  if (splitWidth) {
    const firstW = bounds.w * clamped;
    return [
      { ...bounds, w: firstW },
      { x: bounds.x + firstW, y: bounds.y, w: bounds.w - firstW, h: bounds.h },
    ];
  }
  const firstH = bounds.h * clamped;
  return [
    { ...bounds, h: firstH },
    { x: bounds.x, y: bounds.y + firstH, w: bounds.w, h: bounds.h - firstH },
  ];
}

function balancedSplitIndex(items: readonly RankedItem[]): number {
  const combinedWeight = total(items);
  let leftWeight = 0;
  let splitIndex = 1;
  let closestDelta = Number.POSITIVE_INFINITY;
  for (let index = 1; index < items.length; index++) {
    leftWeight += items[index - 1]!.weight;
    const delta = Math.abs(combinedWeight / 2 - leftWeight);
    if (delta < closestDelta) {
      closestDelta = delta;
      splitIndex = index;
    }
  }
  return splitIndex;
}

function buildPlanNode(
  items: readonly RankedItem[],
  bounds: TreemapBounds,
): TreemapPlanNode {
  if (items.length === 1) {
    return { kind: "leaf", id: items[0]!.id, weight: items[0]!.weight };
  }
  const combinedWeight = total(items);
  const splitIndex = balancedSplitIndex(items);
  const left = items.slice(0, splitIndex);
  const right = items.slice(splitIndex);
  const leftWeight = total(left);
  const splitWidth = bounds.w >= bounds.h;
  const [leftBounds, rightBounds] = splitRect(
    bounds,
    combinedWeight > 0 ? leftWeight / combinedWeight : 0.5,
    splitWidth,
  );
  return {
    kind: "branch",
    splitWidth,
    weight: combinedWeight,
    left: buildPlanNode(left, leftBounds),
    right: buildPlanNode(right, rightBounds),
  };
}

function updatePlanWeights(
  node: TreemapPlanNode,
  items: ReadonlyMap<string, RankedItem>,
): number {
  if (node.kind === "leaf") {
    node.weight = items.get(node.id)?.weight ?? 0;
    return node.weight;
  }
  node.weight =
    updatePlanWeights(node.left, items) + updatePlanWeights(node.right, items);
  return node.weight;
}

function placePlan(
  node: TreemapPlanNode,
  items: ReadonlyMap<string, RankedItem>,
  bounds: TreemapBounds,
  out: TreemapRect[],
): void {
  if (node.kind === "leaf") {
    const item = items.get(node.id);
    if (item) out.push({ id: item.id, weight: item.weight, ...bounds });
    return;
  }
  const leftWeight = node.left.weight;
  const rightWeight = node.right.weight;
  const combinedWeight = leftWeight + rightWeight;
  const [leftBounds, rightBounds] = splitRect(
    bounds,
    combinedWeight > 0 ? leftWeight / combinedWeight : 0.5,
    node.splitWidth,
  );
  placePlan(node.left, items, leftBounds, out);
  placePlan(node.right, items, rightBounds, out);
}

function rankedItems(items: readonly TreemapItem[]): RankedItem[] {
  return items
    .filter((item) => positiveWeight(item.weight))
    .map((item) => ({ ...item, rank: stableRank(item.id) }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

function idsKey(items: readonly RankedItem[]): string {
  return items.map((item) => item.id).join("\0");
}

export function layoutTreemapWithPlan(
  items: readonly TreemapItem[],
  bounds: TreemapBounds,
  previous: TreemapPlan | null = null,
): PlannedTreemap {
  const measured = rankedItems(items);
  if (measured.length === 0 || bounds.w <= 0 || bounds.h <= 0) {
    return { rects: [], plan: null };
  }
  const key = idsKey(measured);
  const aspectRatio = bounds.w / bounds.h;
  const plan =
    previous &&
    previous.idsKey === key &&
    Math.abs(previous.aspectRatio - aspectRatio) < 0.01
      ? previous
      : {
          idsKey: key,
          aspectRatio,
          root: buildPlanNode(measured, bounds),
        };
  const byId = new Map(measured.map((item) => [item.id, item]));
  updatePlanWeights(plan.root, byId);
  const rects: TreemapRect[] = [];
  placePlan(plan.root, byId, bounds, rects);
  return { rects, plan };
}

export function layoutTreemap(
  items: readonly TreemapItem[],
  bounds: TreemapBounds,
): TreemapRect[] {
  return layoutTreemapWithPlan(items, bounds).rects;
}
