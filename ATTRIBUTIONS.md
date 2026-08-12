# Third-party attributions

The dashboard reuses proven open-source libraries and patterns. Licenses of the
notable runtime dependencies used by the visualization layer and app shell:

| Project | License | Use |
| --- | --- | --- |
| [Recharts](https://github.com/recharts/recharts) | MIT | Time-series (throughput) and multi-series (storage trend) charts |
| [Next.js](https://github.com/vercel/next.js) | MIT | Application framework (App Router) |
| [React](https://github.com/facebook/react) | MIT | UI runtime |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | Styling / design tokens |
| [Zod](https://github.com/colinhacks/zod) | MIT | Runtime validation |

## Patterns

- Chart composition and tooltip/direct-label conventions are inspired by the
  **shadcn/ui** chart patterns and **Tremor**-style information hierarchy (both
  MIT). No source was copied verbatim; the `ChartFrame`/`ChartTooltip`
  primitives and the token-driven color language are original to this project.
- The `CapacityRing` and `EventStrip` are hand-authored SVG (no third-party
  charting code) for maximum legibility and zero runtime dependency.

All of the above are permissive (MIT) licenses; their full texts ship inside
`node_modules/<pkg>/LICENSE`. Update this file when adding a dependency whose
license requires attribution.
