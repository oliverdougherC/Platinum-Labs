import type { Config } from "tailwindcss";

/**
 * Tailwind config (PLA-173).
 *
 * Colors, font sizes, and radii resolve from the design-token layer:
 * `--color-*` custom properties defined in globals.css, which mirror
 * `src/lib/design/tokens.ts` (the source of truth). Components consume token
 * classes (`bg-surface`, `text-muted`, `text-title`, `rounded-lg`) instead of
 * hard-coded values.
 */
const withAlpha = (name: string) => `rgb(var(--color-${name}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: withAlpha("bg"),
        surface: withAlpha("surface"),
        "surface-2": withAlpha("surface-2"),
        hairline: withAlpha("hairline"),
        border: withAlpha("border"),
        fg: withAlpha("fg"),
        muted: withAlpha("muted"),
        faint: withAlpha("faint"),
        accent: withAlpha("accent"),
        ok: withAlpha("ok"),
        warn: withAlpha("warn"),
        danger: withAlpha("danger"),
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        // Role-named type scale (mirrors tokens.typeScale)
        display: ["2rem", { lineHeight: "2.35rem", letterSpacing: "-0.01em" }],
        title: ["1.125rem", { lineHeight: "1.6rem" }],
        metric: ["1.5rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em" }],
        body: ["0.9375rem", { lineHeight: "1.4rem" }],
        meta: ["0.8125rem", { lineHeight: "1.15rem" }],
        eyebrow: ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        sm: "0.375rem",
        md: "0.625rem",
        lg: "0.875rem",
        xl: "1.125rem",
      },
      maxWidth: {
        canvas: "2400px",
      },
    },
  },
  plugins: [],
};

export default config;
