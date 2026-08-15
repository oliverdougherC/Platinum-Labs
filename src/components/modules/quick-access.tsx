import type { QuickLink } from "@/lib/quicklinks";

/**
 * Quick access (PLA-175 / PLA-191) — subordinate launch links for common
 * services. Links are configured (browser-facing) and validated server-side;
 * the row is hidden entirely when none are configured.
 */
export function QuickAccess({ links }: { links: QuickLink[] }) {
  if (links.length === 0) return null;
  return (
    <nav aria-label="Quick access" className="flex flex-wrap items-center gap-2">
      {links.map((link) => (
        <a
          key={`${link.label}:${link.href}`}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg px-3 py-1.5 text-meta text-muted ring-1 ring-hairline transition-colors hover:bg-surface hover:text-fg"
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
