import { describe, expect, it } from "vitest";
import { materializePort } from "@/lib/fabric/ports";
import { routeBetweenPorts, routeHitsPorts } from "@/lib/fabric/routing";

describe("fabric route geometry", () => {
  it("uses the exact visible connector centers at both endpoints", () => {
    const source = materializePort(
      { id: "a:network", nodeId: "a", kind: "network", side: "right", offset: 0.25, label: "Network" },
      { x: 10, y: 20, width: 100, height: 80 },
    );
    const target = materializePort(
      { id: "b:network", nodeId: "b", kind: "network", side: "top", offset: 0.75, label: "Network" },
      { x: 300, y: 260, width: 120, height: 60 },
    );
    const route = routeBetweenPorts(source, target);

    expect(routeHitsPorts(route, source, target)).toBe(true);
    expect(route.points[0]).toEqual(source.center);
    expect(route.points.at(-1)).toEqual(target.center);
    expect(route.points[0]!.x).toBe(source.center.x);
    expect(route.points.at(-1)!.y).toBe(target.center.y);
    expect(route.path.startsWith(`M${source.center.x} ${source.center.y}`)).toBe(true);
    expect(route.path.endsWith(`L${target.center.x} ${target.center.y}`)).toBe(true);
  });

  it("is deterministic", () => {
    const a = materializePort(
      { id: "a", nodeId: "a", kind: "read", side: "left", offset: 0.5, label: "Read" },
      { x: 100, y: 100, width: 40, height: 40 },
    );
    const b = materializePort(
      { id: "b", nodeId: "b", kind: "write", side: "right", offset: 0.5, label: "Write" },
      { x: 600, y: 360, width: 40, height: 40 },
    );
    expect(routeBetweenPorts(a, b, 12)).toEqual(routeBetweenPorts(a, b, 12));
  });
});
