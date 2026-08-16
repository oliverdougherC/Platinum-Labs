import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { CommandPalette } from "@/components/command-palette";
import { OverlayShell } from "@/components/ui/overlay-shell";
import { makeFakeSnapshot } from "@/lib/fake/snapshot";

const NOW = 1_754_000_000_000;

beforeAll(() => {
  vi.stubGlobal("open", vi.fn());
});

function renderPalette(overrides?: {
  links?: Array<{ label: string; href: string }>;
  onMediaSearch?: (query: string) => void;
  onOpen?: () => void;
}) {
  return render(
    <CommandPalette
      snapshot={makeFakeSnapshot("idle", NOW)}
      links={overrides?.links ?? []}
      now={NOW}
      onMediaSearch={overrides?.onMediaSearch}
      onOpen={overrides?.onOpen}
    />,
  );
}

describe("CommandPalette", () => {
  it("Cmd/Ctrl+K closes through the reset path and reopens cleanly", () => {
    renderPalette();

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    const input = screen.getByRole("textbox", { name: "Command input" });
    fireEvent.change(input, { target: { value: "downloads" } });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("textbox", { name: "Command input" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("textbox", { name: "Command input" })).toHaveValue("");
  });

  it("Escape closes the palette and a later reopen starts fresh", () => {
    renderPalette();

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    const input = screen.getByRole("textbox", { name: "Command input" });
    fireEvent.change(input, { target: { value: "issues" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Command input" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    expect(screen.getByRole("textbox", { name: "Command input" })).toHaveValue("");
  });

  it("empty results never produce a negative selection", () => {
    renderPalette();

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    const input = screen.getByRole("textbox", { name: "Command input" });
    fireEvent.change(input, { target: { value: "zzzz-no-match" } });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(/No command matched "zzzz-no-match"\./)).toBeInTheDocument();
  });

  it("hands request commands off to media search and closes", () => {
    const onMediaSearch = vi.fn();
    renderPalette({ onMediaSearch });

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    const input = screen.getByRole("textbox", { name: "Command input" });
    fireEvent.change(input, { target: { value: "request dune" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMediaSearch).toHaveBeenCalledWith("dune");
    expect(screen.queryByRole("textbox", { name: "Command input" })).not.toBeInTheDocument();
  });

  it("calls onOpen every time the palette is opened", () => {
    const onOpen = vi.fn();
    renderPalette({ onOpen });

    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Command input" }), { key: "Escape" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

/**
 * Focus restoration with the REAL CommandPalette (V2.1 review blocker): its
 * trigger unmounts while the modal is open, so the generic "trigger stays
 * mounted" overlay test cannot reproduce these paths.
 */
describe("CommandPalette focus restoration", () => {
  it("click-open then Escape focuses the remounted trigger", async () => {
    renderPalette();
    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    const input = screen.getByRole("textbox", { name: "Command input" });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Search and commands" })).toHaveFocus(),
    );
  });

  it("keyboard-activated open then Escape focuses the remounted trigger", async () => {
    renderPalette();
    const trigger = screen.getByRole("button", { name: "Search and commands" });
    trigger.focus();
    // Keyboard activation of a focused button dispatches click.
    fireEvent.click(trigger);
    expect(screen.getByRole("textbox", { name: "Command input" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Search and commands" })).toHaveFocus(),
    );
  });

  it("global Ctrl+K from another control returns focus to that control", async () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <CommandPalette snapshot={makeFakeSnapshot("idle", NOW)} links={[]} now={NOW} />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Command input" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(elsewhere).toHaveFocus());
  });

  /** Palette → media-search handoff, with a real second OverlayShell. */
  function HandoffHarness() {
    const [search, setSearch] = useState<string | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    return (
      <div data-app-shell>
        <CommandPalette
          snapshot={makeFakeSnapshot("idle", NOW)}
          links={[]}
          now={NOW}
          onMediaSearch={(q) => setSearch(q)}
        />
        <OverlayShell
          open={search !== null}
          onClose={() => setSearch(null)}
          label="Media search"
          initialFocusRef={searchInputRef}
        >
          <input ref={searchInputRef} aria-label="Media query" defaultValue={search ?? ""} />
        </OverlayShell>
      </div>
    );
  }

  it("command-to-media-search handoff never leaves focus on an inert or removed node", async () => {
    render(<HandoffHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Search and commands" }));
    const input = screen.getByRole("textbox", { name: "Command input" });
    fireEvent.change(input, { target: { value: "request dune" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The media-search overlay owns focus now; the focused node must be live
    // and outside any inert subtree.
    const query = screen.getByRole("textbox", { name: "Media query" });
    await waitFor(() => expect(query).toHaveFocus());
    const active = document.activeElement as HTMLElement;
    expect(active.isConnected).toBe(true);
    for (let node: HTMLElement | null = active; node; node = node.parentElement) {
      expect(node.inert ?? false).toBe(false);
    }

    // Closing the media search still lands somewhere real (the palette
    // trigger), completing the round trip.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Search and commands" })).toHaveFocus(),
    );
  });
});
