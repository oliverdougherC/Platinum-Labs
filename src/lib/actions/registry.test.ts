import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ActionRegistry, type ActionDefinition } from "@/lib/actions/registry";

type Input = { mediaType: "movie" | "tv"; mediaId: number };

function makeAction(
  overrides: Partial<ActionDefinition<Input, string>> = {},
): ActionDefinition<Input, string> {
  return {
    id: "test.action",
    input: z
      .object({ mediaType: z.enum(["movie", "tv"]), mediaId: z.number().int().positive() })
      .strict(),
    disabledReason: () => null,
    dedupeKey: (input) => `${input.mediaType}:${input.mediaId}`,
    handler: async (input) => `ran ${input.mediaType} ${input.mediaId}`,
    auditResult: (outcome) => outcome,
    ...overrides,
  };
}

describe("ActionRegistry", () => {
  it("rejects unknown action ids — no arbitrary forwarding", async () => {
    const registry = new ActionRegistry();
    registry.register(makeAction());
    expect(await registry.execute("other.action", {})).toEqual({
      status: "unknown-action",
    });
  });

  it("rejects invalid or extra input fields before the handler runs", async () => {
    const handler = vi.fn();
    const registry = new ActionRegistry();
    registry.register(
      makeAction({ handler: handler as unknown as (i: Input) => Promise<string> }),
    );

    for (const bad of [
      undefined,
      null,
      {},
      { mediaType: "movie" },
      { mediaType: "movie", mediaId: -1 },
      { mediaType: "movie", mediaId: 1.5 },
      { mediaType: "person", mediaId: 1 },
      // Extra fields (e.g. Seerr routing params) are rejected, not ignored.
      { mediaType: "movie", mediaId: 1, serverId: 3 },
      { mediaType: "movie", mediaId: 1, rootFolder: "/movies" },
    ]) {
      expect((await registry.execute("test.action", bad)).status).toBe(
        "invalid-input",
      );
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses disabled actions with the declared reason", async () => {
    const registry = new ActionRegistry();
    registry.register(makeAction({ disabledReason: () => "not configured" }));
    expect(
      await registry.execute("test.action", { mediaType: "movie", mediaId: 1 }),
    ).toEqual({ status: "disabled", reason: "not configured" });
  });

  it("runs a valid action and reports the audit line", async () => {
    const registry = new ActionRegistry();
    registry.register(makeAction());
    expect(
      await registry.execute("test.action", { mediaType: "movie", mediaId: 7 }),
    ).toEqual({ status: "ok", result: "ran movie 7", audit: "ran movie 7" });
  });

  it("shares one in-flight execution across concurrent duplicate submissions", async () => {
    let resolveHandler!: (v: string) => void;
    const handler = vi.fn(
      () => new Promise<string>((resolve) => (resolveHandler = resolve)),
    );
    const registry = new ActionRegistry();
    registry.register(makeAction({ handler }));

    const input = { mediaType: "movie" as const, mediaId: 7 };
    const first = registry.execute("test.action", input);
    const second = registry.execute("test.action", input); // double-click
    resolveHandler("done");

    const [a, b] = await Promise.all([first, second]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("does not dedupe distinct media", async () => {
    const handler = vi.fn(async (i: Input) => `ran ${i.mediaId}`);
    const registry = new ActionRegistry();
    registry.register(makeAction({ handler }));

    await Promise.all([
      registry.execute("test.action", { mediaType: "movie", mediaId: 1 }),
      registry.execute("test.action", { mediaType: "movie", mediaId: 2 }),
    ]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("allows a fresh execution after the previous one settles", async () => {
    const handler = vi.fn(async () => "ok");
    const registry = new ActionRegistry();
    registry.register(makeAction({ handler }));

    const input = { mediaType: "tv" as const, mediaId: 9 };
    await registry.execute("test.action", input);
    await registry.execute("test.action", input);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("refuses duplicate registrations", () => {
    const registry = new ActionRegistry();
    registry.register(makeAction());
    expect(() => registry.register(makeAction())).toThrow(
      "action already registered",
    );
  });
});
