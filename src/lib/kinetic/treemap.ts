/**
 * Stable weighted-binary treemap used by the kinetic container field.
 *
 * A container's stable identity chooses a persistent branch in the binary
 * partition tree. Each hash-bit depth has a fixed split axis and each branch
 * divides according to the exact sum of its children's weights. That gives us
 * three useful properties:
 * every positive item is represented, area is exactly proportional to raw
 * memory, and changing a weight moves existing boundaries continuously instead
 * of re-sorting the whole field on small rank crossings.
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

function place(
  items: readonly RankedItem[],
  bounds: TreemapBounds,
  bit: number,
  out: TreemapRect[],
): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    const item = items[0]!;
    out.push({ id: item.id, weight: item.weight, ...bounds });
    return;
  }

  // A hash collision is extremely unlikely, but identity still needs a
  // deterministic layout if it happens.
  if (bit < 0) {
    const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const midpoint = Math.ceil(ordered.length / 2);
    const fallbackLeft = ordered.slice(0, midpoint);
    const fallbackRight = ordered.slice(midpoint);
    const fallbackLeftWeight = total(fallbackLeft);
    const fallbackCombined = fallbackLeftWeight + total(fallbackRight);
    const [fallbackLeftBounds, fallbackRightBounds] = splitRect(
      bounds,
      fallbackCombined > 0 ? fallbackLeftWeight / fallbackCombined : 0.5,
      true,
    );
    place(fallbackLeft, fallbackLeftBounds, -1, out);
    place(fallbackRight, fallbackRightBounds, -1, out);
    return;
  }

  const left: RankedItem[] = [];
  const right: RankedItem[] = [];
  for (const item of items) {
    ((item.rank >>> bit) & 1 ? right : left).push(item);
  }

  // Preserve unary hash-trie levels instead of compressing them. Advancing
  // the fixed axis schedule through an empty branch means adding/removing a
  // near-zero item converges to the exact same geometry as the absent state.
  if (left.length === 0) {
    place(right, bounds, bit - 1, out);
    return;
  }
  if (right.length === 0) {
    place(left, bounds, bit - 1, out);
    return;
  }

  const leftWeight = total(left);
  const combinedWeight = leftWeight + total(right);
  const [leftBounds, rightBounds] = splitRect(
    bounds,
    combinedWeight > 0 ? leftWeight / combinedWeight : 0.5,
    (31 - bit) % 2 === 0,
  );
  place(left, leftBounds, bit - 1, out);
  place(right, rightBounds, bit - 1, out);
}

export function layoutTreemap(
  items: readonly TreemapItem[],
  bounds: TreemapBounds,
): TreemapRect[] {
  const measured = items
    .filter((item) => positiveWeight(item.weight))
    .map((item) => ({ ...item, rank: stableRank(item.id) }));
  if (measured.length === 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  const out: TreemapRect[] = [];
  place(measured, bounds, 31, out);
  return out;
}
