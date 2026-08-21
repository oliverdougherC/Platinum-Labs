import { formatBytes } from "@/lib/format/bytes";

export const CONTAINER_TOOLTIP_WIDTH = 232;
export const CONTAINER_TOOLTIP_HEIGHT = 72;
const EDGE_PAD = 8;
const TILE_GAP = 10;

export interface ContainerTooltipSource {
  name: string;
  cpuFraction: number | null;
  memoryBytes: number | null;
  uptimeSeconds: number | null;
  freshness: "live" | "stale" | "unavailable";
  unverified: boolean;
}

export interface ContainerTooltipContent {
  name: string;
  uptime: string;
  cpu: string;
  memory: string;
}

export interface TooltipTileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function formatContainerUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "unknown";
  if (totalSeconds < 1) return "<1s";
  const seconds = Math.floor(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`;
}

export function buildContainerTooltip(
  source: ContainerTooltipSource,
): ContainerTooltipContent {
  if (source.freshness === "stale") {
    return { name: source.name, uptime: "stale", cpu: "CPU stale", memory: "stale" };
  }
  if (source.freshness === "unavailable" || source.unverified) {
    return {
      name: source.name,
      uptime: "unknown",
      cpu: "CPU unknown",
      memory: "unknown",
    };
  }
  const cpu =
    source.cpuFraction !== null &&
    Number.isFinite(source.cpuFraction) &&
    source.cpuFraction >= 0
      ? `CPU ${(source.cpuFraction * 100).toFixed(1)}%`
      : "CPU unknown";
  const memory =
    source.memoryBytes !== null &&
    Number.isFinite(source.memoryBytes) &&
    source.memoryBytes >= 0
      ? formatBytes(source.memoryBytes, { digits: 1 })
      : "unknown";
  return {
    name: source.name,
    uptime:
      source.uptimeSeconds === null
        ? "unknown"
        : formatContainerUptime(source.uptimeSeconds),
    cpu,
    memory,
  };
}

export function placeContainerTooltip(
  tile: TooltipTileRect,
  viewport: { w: number; h: number },
  tooltip = {
    w: CONTAINER_TOOLTIP_WIDTH,
    h: CONTAINER_TOOLTIP_HEIGHT,
  },
): { left: number; top: number } {
  const centered = tile.x + tile.w / 2 - tooltip.w / 2;
  const left = Math.min(
    Math.max(EDGE_PAD, centered),
    Math.max(EDGE_PAD, viewport.w - tooltip.w - EDGE_PAD),
  );
  const above = tile.y - tooltip.h - TILE_GAP;
  const below = tile.y + tile.h + TILE_GAP;
  const preferredTop = above >= EDGE_PAD ? above : below;
  const top = Math.min(
    Math.max(EDGE_PAD, preferredTop),
    Math.max(EDGE_PAD, viewport.h - tooltip.h - EDGE_PAD),
  );
  return { left, top };
}
