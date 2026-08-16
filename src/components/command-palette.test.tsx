import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "@/components/command-palette";
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
