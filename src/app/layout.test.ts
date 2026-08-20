import { describe, expect, it } from "vitest";
import { metadata } from "@/app/layout";

describe("layout metadata", () => {
  it("uses Platinum Labs as the exact visible brand metadata", () => {
    expect(metadata.title).toBe("Platinum Labs");
    expect(metadata.description).toBe("Platinum Labs");
  });
});
