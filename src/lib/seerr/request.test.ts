import { describe, expect, it, vi } from "vitest";
import { performSeerrRequest } from "@/lib/seerr/request";
import { MEDIA_STATUS, REQUEST_STATUS } from "@/lib/seerr/api";
import { SeerrHttpError } from "@/lib/seerr/client.server";
import type { SeerrClient } from "@/lib/seerr/client.server";

const API_KEY = "super-secret-api-key";

/** Build a stub client; unset operations fail the test if called. */
function stubClient(overrides: Partial<SeerrClient>): SeerrClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected client call: ${name}`);
  };
  return {
    search: unexpected("search"),
    movieDetails: unexpected("movieDetails"),
    tvDetails: unexpected("tvDetails"),
    createRequest: unexpected("createRequest"),
    approveRequest: unexpected("approveRequest"),
    ...overrides,
  };
}

const movieDetails = (status?: number) => ({
  id: 101,
  title: "The Martian",
  mediaInfo: status === undefined ? undefined : { status },
});

const tvDetails = (opts: {
  seasons?: Array<{ seasonNumber: number; episodeCount: number }>;
  tracked?: Array<{ seasonNumber: number; status: number }>;
  status?: number;
}) => ({
  id: 111,
  name: "Foundation",
  seasons:
    opts.seasons ??
    [
      { seasonNumber: 1, episodeCount: 10 },
      { seasonNumber: 2, episodeCount: 10 },
    ],
  mediaInfo:
    opts.status === undefined && opts.tracked === undefined
      ? undefined
      : { status: opts.status ?? MEDIA_STATUS.PARTIALLY_AVAILABLE, seasons: opts.tracked },
});

const request = (status: number, id = 900) => ({ id, status, media: { status: 3 } });

describe("performSeerrRequest — movie", () => {
  it("creates a movie request with the minimal payload and succeeds when already approved", async () => {
    const createRequest = vi.fn(async () => request(REQUEST_STATUS.APPROVED));
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest,
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toEqual({ ok: true, outcome: "approved", title: "The Martian" });
    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledWith({
      mediaType: "movie",
      mediaId: 101,
    });
  });

  it("explicitly approves a pending create response and verifies the result", async () => {
    const approveRequest = vi.fn(async () => request(REQUEST_STATUS.APPROVED, 901));
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => request(REQUEST_STATUS.PENDING, 901),
      approveRequest,
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toEqual({ ok: true, outcome: "approved", title: "The Martian" });
    expect(approveRequest).toHaveBeenCalledTimes(1);
    expect(approveRequest).toHaveBeenCalledWith(901);
  });

  it("REGRESSION: a pending create response NEVER becomes success without a confirmed approval", async () => {
    // Approval endpoint fails → the overall action must fail, even though the
    // create call returned a request id.
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => request(REQUEST_STATUS.PENDING),
      approveRequest: async () => {
        throw new SeerrHttpError(500);
      },
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("approval-failed");
      expect(outcome.message).toContain("approval could not be confirmed");
    }
  });

  it("fails when the approval response is still not APPROVED", async () => {
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => request(REQUEST_STATUS.PENDING),
      // Approve "succeeds" at the HTTP level but the state says otherwise.
      approveRequest: async () => request(REQUEST_STATUS.PENDING),
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toMatchObject({ ok: false, code: "approval-failed" });
  });

  it("fails when the approval response is malformed", async () => {
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => request(REQUEST_STATUS.PENDING),
      approveRequest: async () => ({ nonsense: true }),
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toMatchObject({ ok: false, code: "approval-failed" });
  });

  it("returns already-requested for media Seerr already tracks, without creating", async () => {
    const createRequest = vi.fn();
    const client = stubClient({
      movieDetails: async () => movieDetails(MEDIA_STATUS.AVAILABLE),
      createRequest: createRequest as unknown as SeerrClient["createRequest"],
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toEqual({
      ok: true,
      outcome: "already-requested",
      state: "available",
      title: "The Martian",
    });
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("collapses an upstream duplicate (409) into a stable already-requested state", async () => {
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => {
        throw new SeerrHttpError(409);
      },
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toEqual({
      ok: true,
      outcome: "already-requested",
      state: "pending",
      title: "The Martian",
    });
  });

  it("REGRESSION: a retry after a lost success response creates no second request", async () => {
    // First call succeeds (approved) but the browser never sees the response;
    // an immediate retry re-resolves the media, finds Seerr now tracks it, and
    // settles as already-requested without a second createRequest.
    let requested = false;
    const createRequest = vi.fn(async () => {
      requested = true;
      return request(REQUEST_STATUS.APPROVED);
    });
    const client = stubClient({
      movieDetails: async () =>
        movieDetails(requested ? MEDIA_STATUS.PROCESSING : undefined),
      createRequest,
    });

    const first = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });
    const retry = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(first).toEqual({ ok: true, outcome: "approved", title: "The Martian" });
    expect(retry).toEqual({
      ok: true,
      outcome: "already-requested",
      state: "processing",
      title: "The Martian",
    });
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it("fails with a sanitized message when create fails", async () => {
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => {
        throw new SeerrHttpError(500);
      },
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toMatchObject({ ok: false, code: "request-failed" });
    if (!outcome.ok) {
      expect(outcome.message).not.toContain(API_KEY);
      expect(outcome.message).toBe("Seerr returned HTTP 500");
    }
  });

  it("fails as unavailable when Seerr cannot be reached at all", async () => {
    const client = stubClient({
      movieDetails: async () => {
        throw new Error(`ECONNREFUSED http://seerr:5055?key=${API_KEY}`);
      },
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toMatchObject({ ok: false, code: "unavailable" });
    if (!outcome.ok) {
      // Unknown errors sanitize to the generic message — no URL, no key.
      expect(outcome.message).toBe("Upstream request failed");
    }
  });

  it("fails cleanly when the create response is malformed", async () => {
    const client = stubClient({
      movieDetails: async () => movieDetails(),
      createRequest: async () => ({ unexpected: "shape" }),
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "movie",
      mediaId: 101,
    });

    expect(outcome).toMatchObject({ ok: false, code: "request-failed" });
  });
});

describe("performSeerrRequest — tv", () => {
  it("requests ALL seasons for an entirely untracked series", async () => {
    const createRequest = vi.fn(async () => request(REQUEST_STATUS.APPROVED));
    const client = stubClient({
      tvDetails: async () => tvDetails({}),
      createRequest,
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "tv",
      mediaId: 111,
    });

    expect(outcome).toEqual({ ok: true, outcome: "approved", title: "Foundation" });
    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledWith({
      mediaType: "tv",
      mediaId: 111,
      seasons: "all",
    });
  });

  it("requests only the missing seasons of a partially tracked series", async () => {
    const createRequest = vi.fn(async () => request(REQUEST_STATUS.APPROVED));
    const client = stubClient({
      tvDetails: async () =>
        tvDetails({
          seasons: [
            { seasonNumber: 1, episodeCount: 10 },
            { seasonNumber: 2, episodeCount: 10 },
            { seasonNumber: 3, episodeCount: 10 },
          ],
          tracked: [{ seasonNumber: 1, status: MEDIA_STATUS.AVAILABLE }],
        }),
      createRequest,
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "tv",
      mediaId: 111,
    });

    expect(outcome).toMatchObject({ ok: true, outcome: "approved" });
    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(createRequest).toHaveBeenCalledWith({
      mediaType: "tv",
      mediaId: 111,
      seasons: [2, 3],
    });
  });

  it("returns already-requested when every season is already tracked", async () => {
    const createRequest = vi.fn();
    const client = stubClient({
      tvDetails: async () =>
        tvDetails({
          status: MEDIA_STATUS.PROCESSING,
          tracked: [
            { seasonNumber: 1, status: MEDIA_STATUS.PROCESSING },
            { seasonNumber: 2, status: MEDIA_STATUS.PENDING },
          ],
        }),
      createRequest: createRequest as unknown as SeerrClient["createRequest"],
    });

    const outcome = await performSeerrRequest(client, {
      mediaType: "tv",
      mediaId: 111,
    });

    expect(outcome).toEqual({
      ok: true,
      outcome: "already-requested",
      state: "processing",
      title: "Foundation",
    });
    expect(createRequest).not.toHaveBeenCalled();
  });
});
