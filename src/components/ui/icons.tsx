import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function IconFrame({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (props: IconProps) => (
  <IconFrame {...props}>
    <circle cx="8.5" cy="8.5" r="4.75" />
    <path d="m12 12 4.25 4.25" />
  </IconFrame>
);

export const MediaRequestIcon = (props: IconProps) => (
  <IconFrame {...props}>
    <rect x="2.75" y="4.5" width="10.5" height="8.5" rx="2" />
    <path d="m7.25 7.15 3.1 1.6-3.1 1.6Z" fill="currentColor" stroke="none" />
    <path d="M15.25 10.5v5M12.75 13h5" />
  </IconFrame>
);

export const BellIcon = (props: IconProps) => (
  <IconFrame {...props}>
    <path d="M4.5 14.5h11c-1.2-1.3-1.6-2.5-1.6-5a3.9 3.9 0 0 0-7.8 0c0 2.5-.4 3.7-1.6 5Z" />
    <path d="M8.2 16.5c.45.7 1.05 1 1.8 1s1.35-.3 1.8-1" />
  </IconFrame>
);

export const ConnectionWarningIcon = (props: IconProps) => (
  <IconFrame {...props}>
    <path d="M4.2 7.6a7 7 0 0 1 11.2-1.8M15.8 12.4a7 7 0 0 1-11.2 1.8" />
    <path d="m14.8 3.8.8 2.2-2.3.4M5.2 16.2 4.4 14l2.3-.4" />
  </IconFrame>
);

export const CloseIcon = (props: IconProps) => (
  <IconFrame {...props}>
    <path d="m5 5 10 10M15 5 5 15" />
  </IconFrame>
);

export const OBSERVATORY_CONTROL_CLASS =
  "flex h-10 min-w-10 items-center justify-center gap-2 rounded-lg px-2.5 text-[11px] uppercase tracking-[0.11em] text-faint outline-none transition-colors hover:bg-surface-2 hover:text-muted focus-visible:ring-1 focus-visible:ring-accent/80 disabled:cursor-not-allowed disabled:opacity-40";
