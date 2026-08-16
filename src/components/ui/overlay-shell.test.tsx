import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { DrawerShell, OverlayShell } from "@/components/ui/overlay-shell";

afterEach(cleanup);

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div data-app-shell>
        <button type="button" onClick={() => setOpen(true)}>Open details</button>
        <button type="button">Background action</button>
      </div>
      <DrawerShell
        open={open}
        onClose={() => setOpen(false)}
        title="Service details"
        closeLabel="Close details"
      >
        <input aria-label="First field" />
        <button type="button">Last action</button>
      </DrawerShell>
    </>
  );
}

describe("OverlayShell", () => {
  it("unmounts while closed, makes the background inert, and focuses on open", () => {
    render(<DrawerHarness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(screen.getByRole("dialog", { name: "Service details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Open details" }).parentElement).toHaveProperty("inert", true);
  });

  it("traps focus in both directions", () => {
    render(<DrawerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));

    const close = screen.getByRole("button", { name: "Close details" });
    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("closes on Escape, unmounts controls, restores focus, and removes inertness", async () => {
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "Open details" });
    // fireEvent does not synthesize the browser's pointer-focus step.
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Last action" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger.parentElement).toHaveProperty("inert", false);
  });

  it("only lets the topmost overlay handle Escape", () => {
    const closeBottom = vi.fn();
    const closeTop = vi.fn();
    render(
      <>
        <OverlayShell open onClose={closeBottom} label="Bottom"><button>Bottom</button></OverlayShell>
        <OverlayShell open onClose={closeTop} label="Top"><button>Top</button></OverlayShell>
      </>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeTop).toHaveBeenCalledOnce();
    expect(closeBottom).not.toHaveBeenCalled();
  });

  it("uses a bounded viewport-relative drawer width", () => {
    render(<DrawerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(screen.getByRole("dialog")).toHaveClass("w-[min(92vw,28rem)]");
  });
});
