import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("/api/health", () => {
  it("returns 200 with a liveness payload and no-store caching", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      status: string;
      uptimeSeconds: number;
      revision: string;
    };
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.revision).toBe("string");
    expect(body.revision.length).toBeGreaterThan(0);
  });
});
