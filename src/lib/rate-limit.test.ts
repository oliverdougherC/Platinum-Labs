import { describe, expect, it } from "vitest";
import { makeRateLimiter } from "@/lib/rate-limit";

describe("makeRateLimiter", () => {
  it("allows up to max acquisitions per window, then refuses", () => {
    const limiter = makeRateLimiter({ windowMs: 1000, max: 3 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(10)).toBe(true);
    expect(limiter.tryAcquire(20)).toBe(true);
    expect(limiter.tryAcquire(30)).toBe(false);
  });

  it("resets when the window elapses", () => {
    const limiter = makeRateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.tryAcquire(0)).toBe(true);
    expect(limiter.tryAcquire(500)).toBe(false);
    expect(limiter.tryAcquire(1000)).toBe(true);
  });
});
