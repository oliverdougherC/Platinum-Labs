import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MediaSearch, MediaSearchLauncher } from "@/components/media-search";
import type { SeerrRequestOutcome, SeerrSearchResult } from "@/lib/seerr/api";

const martian: SeerrSearchResult = {
  id: 101,
  mediaType: "movie",
  title: "The Martian",
  year: 2015,
  posterPath: null,
  overview: "Stranded on Mars.",
  state: "requestable",
};

const dune: SeerrSearchResult = {
  id: 511,
  mediaType: "movie",
  title: "Dune: Part Two",
  year: 2024,
  posterPath: null,
  overview: null,
  state: "available",
};

const andor: SeerrSearchResult = {
  id: 322,
  mediaType: "tv",
  title: "Andor",
  year: 2022,
  posterPath: null,
  overview: null,
  state: "partial",
};

type FetchCall = { url: string; init?: RequestInit };

/** Script fetch by URL prefix; records calls for assertions. */
function scriptFetch(
  respond: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    }),
  );
  return calls;
}

function searchResponse(results: SeerrSearchResult[]): Response {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function outcomeResponse(outcome: SeerrRequestOutcome, status = 200): Response {
  return new Response(JSON.stringify(outcome), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSearch(props: Partial<Parameters<typeof MediaSearch>[0]> = {}) {
  return render(
    <MediaSearch
      open
      requestsEnabled
      onClose={() => {}}
      {...props}
    />,
  );
}

async function typeQuery(text: string) {
  fireEvent.change(screen.getByLabelText("Search movies and TV"), {
    target: { value: text },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MediaSearchLauncher", () => {
  it("renders the quiet entry point and opens on click", () => {
    const onOpen = vi.fn();
    render(<MediaSearchLauncher onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /request media/i }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("MediaSearch — searching", () => {
  it("debounces and renders normalized results with state labels", async () => {
    const calls = scriptFetch(() => searchResponse([martian, dune]));
    renderSearch();

    await typeQuery("mar");
    expect(await screen.findByText("The Martian")).toBeInTheDocument();
    expect(screen.getByText("(2015)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request" })).toBeInTheDocument();
    // Available media replaces the request control with a truthful state.
    expect(screen.getByText("Available")).toBeInTheDocument();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/seerr/search?q=mar");
  });

  it("does not query below the minimum length", async () => {
    const calls = scriptFetch(() => searchResponse([]));
    renderSearch();
    await typeQuery("a");
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/at least two characters/i)).toBeInTheDocument();
  });

  it("shows a truthful empty state", async () => {
    scriptFetch(() => searchResponse([]));
    renderSearch();
    await typeQuery("zzzz");
    expect(await screen.findByText(/no movies or shows matched/i)).toBeInTheDocument();
  });

  it("surfaces sanitized search failures with a retry", async () => {
    let fail = true;
    scriptFetch(() => {
      if (fail) {
        return new Response(JSON.stringify({ error: "Seerr is unreachable" }), {
          status: 502,
        });
      }
      return searchResponse([martian]);
    });
    renderSearch();

    await typeQuery("mar");
    expect(await screen.findByText("Seerr is unreachable")).toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("The Martian")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    scriptFetch(() => searchResponse([]));
    const onClose = vi.fn();
    renderSearch({ onClose });
    fireEvent.keyDown(screen.getByLabelText("Search movies and TV"), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("MediaSearch — stale queries (PLA-256 remediation)", () => {
  it("REGRESSION: Enter after the query changes can never request a stale row", async () => {
    const calls = scriptFetch((url) => {
      if (url.startsWith("/api/seerr/search?q=mar")) {
        return searchResponse([martian]);
      }
      // Query B (and anything else) stays pending for the whole test.
      return new Promise<Response>(() => {});
    });
    renderSearch();
    await typeQuery("mar");
    await screen.findByText("The Martian");

    await typeQuery("dune");
    // The old query's rows are cleared the moment the input changes — before
    // the debounce fires — so they are no longer rendered or actionable.
    expect(screen.queryByText("The Martian")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("Search movies and TV"), {
      key: "Enter",
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.filter((c) => c.url.includes("actions"))).toHaveLength(0);
  });

  it("REGRESSION: an out-of-order stale response never overwrites the current query", async () => {
    let releaseA!: (r: Response) => void;
    const gateA = new Promise<Response>((resolve) => (releaseA = resolve));
    scriptFetch((url) => {
      // Query A hangs (and, like a real network race, ignores its abort);
      // query B responds immediately.
      if (url.startsWith("/api/seerr/search?q=old")) return gateA;
      return searchResponse([dune]);
    });
    renderSearch();
    await typeQuery("old");
    // Let A's debounce elapse so its fetch is actually in flight.
    await new Promise((r) => setTimeout(r, 350));

    await typeQuery("dune");
    expect(await screen.findByText("Dune: Part Two")).toBeInTheDocument();

    // A resolves only now, after B became current: it must be discarded.
    releaseA(searchResponse([martian]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("The Martian")).not.toBeInTheDocument();
    expect(screen.getByText("Dune: Part Two")).toBeInTheDocument();
  });
});

describe("MediaSearch — requesting", () => {
  function scriptSearchAndRequest(outcome: () => Response) {
    return scriptFetch((url, init) => {
      if (url.startsWith("/api/seerr/search")) {
        return searchResponse([martian, andor]);
      }
      expect(url).toBe("/api/actions/seerr.request");
      expect(init?.method).toBe("POST");
      return outcome();
    });
  }

  it("requests a movie and only shows Approved after backend confirmation", async () => {
    const calls = scriptSearchAndRequest(() =>
      outcomeResponse({ ok: true, outcome: "approved", title: "The Martian" }),
    );
    renderSearch();
    await typeQuery("mar");
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));

    expect(await screen.findByText("Approved")).toBeInTheDocument();
    const actionCalls = calls.filter((c) => c.url.includes("actions"));
    expect(actionCalls).toHaveLength(1);
    expect(JSON.parse(actionCalls[0]!.init!.body as string)).toEqual({
      mediaType: "movie",
      mediaId: 101,
    });
  });

  it("labels partial TV with an explicit Request missing action", async () => {
    scriptSearchAndRequest(() =>
      outcomeResponse({ ok: true, outcome: "approved", title: "Andor" }),
    );
    renderSearch();
    await typeQuery("mar");
    const missing = await screen.findByRole("button", { name: "Request missing" });
    fireEvent.click(missing);
    expect(await screen.findByText("Approved")).toBeInTheDocument();
  });

  it("shows Requesting… while in flight and ignores rapid double-clicks", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => (release = resolve));
    const calls = scriptFetch((url) => {
      if (url.startsWith("/api/seerr/search")) return searchResponse([martian]);
      return gate;
    });
    renderSearch();
    await typeQuery("mar");

    const button = await screen.findByRole("button", { name: "Request" });
    fireEvent.click(button);
    expect(await screen.findByText("Requesting…")).toBeInTheDocument();
    // Second activation while in flight: Enter on the selected row.
    fireEvent.keyDown(screen.getByLabelText("Search movies and TV"), {
      key: "Enter",
    });

    release(
      outcomeResponse({ ok: true, outcome: "approved", title: "The Martian" }),
    );
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("actions"))).toHaveLength(1);
  });

  it("shows a truthful state when the media was already requested", async () => {
    scriptSearchAndRequest(() =>
      outcomeResponse({
        ok: true,
        outcome: "already-requested",
        state: "pending",
        title: "The Martian",
      }),
    );
    renderSearch();
    await typeQuery("mar");
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));
    expect(await screen.findByText("Pending approval")).toBeInTheDocument();
  });

  it("REGRESSION: an unconfirmed approval renders a failure with retry, never success", async () => {
    scriptSearchAndRequest(() =>
      outcomeResponse(
        {
          ok: false,
          code: "approval-failed",
          message: "Request created but approval could not be confirmed",
        },
        502,
      ),
    );
    renderSearch();
    await typeQuery("mar");
    fireEvent.click(await screen.findByRole("button", { name: "Request" }));

    expect(
      await screen.findByText(/approval could not be confirmed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("requests via Enter on the keyboard-selected row", async () => {
    const calls = scriptSearchAndRequest(() =>
      outcomeResponse({ ok: true, outcome: "approved", title: "The Martian" }),
    );
    renderSearch();
    await typeQuery("mar");
    await screen.findByText("The Martian");

    fireEvent.keyDown(screen.getByLabelText("Search movies and TV"), {
      key: "Enter",
    });
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes("actions"))).toHaveLength(1);
  });

  it("never advertises request controls when requests are disabled", async () => {
    scriptFetch(() => searchResponse([martian]));
    renderSearch({ requestsEnabled: false });
    await typeQuery("mar");
    await screen.findByText("The Martian");
    expect(screen.queryByRole("button", { name: "Request" })).not.toBeInTheDocument();
  });
});
