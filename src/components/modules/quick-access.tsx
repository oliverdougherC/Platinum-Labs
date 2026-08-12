import { appConfig } from "@/lib/config";

/**
 * Quick access (PLA-175) — subordinate launch links for common services. The
 * deterministic command palette that supersedes/augments this arrives in
 * PLA-191; the page is fully useful without it.
 */
export function QuickAccess() {
  return (
    <nav aria-label="Quick access" className="flex flex-wrap items-center gap-2">
      {appConfig.quickLinks.map((link) => (
        <a
          key={link.label}
          href={link.href}
          className="rounded-lg px-3 py-1.5 text-meta text-muted ring-1 ring-hairline transition-colors hover:bg-surface hover:text-fg"
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
