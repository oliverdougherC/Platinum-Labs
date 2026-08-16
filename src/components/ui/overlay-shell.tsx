"use client";

import {
  type RefObject,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { CloseIcon } from "@/components/ui/icons";

type OverlayEntry = {
  id: string;
  root: HTMLElement;
};

const overlayStack: OverlayEntry[] = [];

function syncOverlayInteractivity() {
  const top = overlayStack.at(-1)?.root ?? null;
  document.querySelectorAll<HTMLElement>("[data-app-shell]").forEach((node) => {
    node.inert = overlayStack.length > 0;
  });
  overlayStack.forEach(({ root }) => {
    root.inert = root !== top;
  });
}

function registerOverlay(entry: OverlayEntry) {
  overlayStack.push(entry);
  syncOverlayInteractivity();
  return () => {
    const index = overlayStack.findIndex(({ id }) => id === entry.id);
    if (index >= 0) overlayStack.splice(index, 1);
    syncOverlayInteractivity();
  };
}

function isTopOverlay(id: string) {
  return overlayStack.at(-1)?.id === id;
}

/**
 * Whether an element can meaningfully receive restored focus: it must still
 * be in the document, be a real control (not the body fallback that
 * `document.activeElement` reports), and not sit inside an inert subtree —
 * focusing an inert node silently fails, leaving focus on <body>.
 */
function canRestoreFocusTo(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (el === document.body || el === document.documentElement) return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.inert) return false;
  }
  return true;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "[href]",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
}

export function OverlayShell({
  open,
  onClose,
  label,
  labelledBy,
  describedBy,
  initialFocusRef,
  returnFocusRef,
  children,
  kind = "modal",
  panelClassName,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Fallback focus target for close, read at close time. Needed when the
   * triggering control UNMOUNTS while the overlay is open (the command
   * palette trigger does): the captured `document.activeElement` is a dead
   * node by then, and focus must land on the freshly remounted control
   * instead. The captured element still wins while it remains usable, so a
   * palette opened via a global shortcut returns focus to whatever control
   * actually had it.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  kind?: "modal" | "drawer";
  panelClassName?: string;
  closeOnBackdrop?: boolean;
}) {
  const reactId = useId();
  const id = `overlay-${reactId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const capturedFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || !rootRef.current || !panelRef.current) return;
    capturedFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = registerOverlay({ id, root: rootRef.current });
    const panel = panelRef.current;
    (initialFocusRef?.current ?? focusableElements(panel)[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopOverlay(id)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unregister();
      const captured = capturedFocusRef.current;
      const target = canRestoreFocusTo(captured)
        ? captured
        : canRestoreFocusTo(returnFocusRef?.current)
          ? returnFocusRef.current
          : null;
      // No usable target (e.g. handoff to another overlay that is about to
      // capture focus itself): better to leave focus alone than to focus an
      // inert or removed node.
      if (target) target.focus();
    };
  }, [id, initialFocusRef, returnFocusRef, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={rootRef}
      data-overlay-root={id}
      className={cn(
        "fixed inset-0 z-50 flex bg-black/25 backdrop-blur-[2px]",
        kind === "drawer" ? "justify-end" : "items-start justify-center px-4 pt-[12dvh]",
      )}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget && isTopOverlay(id)) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        data-overlay-panel
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          "outline-none",
          kind === "drawer"
            ? "flex h-full w-[min(92vw,28rem)] flex-col border-l border-hairline bg-surface/95 shadow-2xl backdrop-blur-sm"
            : "w-full max-w-xl overflow-hidden rounded-xl bg-surface shadow-2xl ring-1 ring-hairline",
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DrawerShell({
  open,
  onClose,
  title,
  closeLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <OverlayShell
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      initialFocusRef={closeRef}
      kind="drawer"
    >
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
        <h2 id={titleId} className="text-[11px] uppercase tracking-[0.18em] text-faint">
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="grid h-10 w-10 place-items-center rounded-lg text-faint outline-none transition-colors hover:bg-surface-2 hover:text-muted focus-visible:ring-1 focus-visible:ring-accent/80"
        >
          <CloseIcon />
        </button>
      </header>
      {children}
    </OverlayShell>
  );
}
