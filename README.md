# Homelab Homepage

An ambient, data-rich homelab operations homepage — useful at a glance, pleasant
to leave on a secondary monitor all day, and quiet when nothing needs attention.

This repository tracks the Linear project **Homelab Homepage** (team `PLA`).
Linear is the source of truth for scope, milestones, and acceptance criteria.

## Status

Milestone 01 — Design & Application Foundation is in progress. This commit is the
production scaffold (**PLA-172**): a greenfield Next.js App Router app with strict
TypeScript, Tailwind, Zod, Recharts, a Vitest test runner, a hard server/client
boundary, and a local fake-data mode so UI work never depends on live services.

## Tech stack

- **Next.js** (App Router) + **React 19**
- **TypeScript** (strict, `noUncheckedIndexedAccess`, no unused locals/params)
- **Tailwind CSS** with CSS-variable design tokens
- **Zod** for runtime validation of config/connector responses
- **Recharts** for data visualization (chart language: PLA-176)
- **Vitest** + Testing Library (jsdom) for unit/component tests

## Requirements

- Node.js >= 20 (developed on Node 22)
- npm 10+

## Local development

```bash
npm install            # install dependencies
cp .env.example .env.local   # optional; app defaults to fake data with no env
npm run dev            # start the dev server at http://localhost:3000
```

The app boots in **fake-data mode** by default (`HOMELAB_DATA_MODE=fake`) and
needs **no real homelab credentials**. Choose a scenario with
`HOMELAB_FAKE_SCENARIO=idle|active|attention`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | `next lint` |
| `npm run test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run check` | typecheck + lint + test (CI gate) |

## Architecture (foundation)

```
src/
  app/                 # App Router entry (server components by default)
    layout.tsx
    page.tsx           # foundation homepage; renders the normalized snapshot
    globals.css        # design tokens + base styles (no remote fonts)
  components/          # presentational + client components
  lib/
    types.ts           # normalized, connector-agnostic domain types (isomorphic)
    config.ts          # non-secret typed config (safe on the client)
    utils.ts           # isomorphic formatting helpers
    env.server.ts      # `server-only` env parsing (secrets never reach the browser)
    snapshot.server.ts # `server-only` fake/live snapshot entry point
    fake/snapshot.ts   # deterministic fake data (seed of PLA-177)
```

### Server / client boundary

Secrets and data-source logic are isolated on the server:

- `src/lib/env.server.ts` and `src/lib/snapshot.server.ts` start with
  `import "server-only"`. If either is ever imported into a client component, the
  **build fails** — enforcing "never expose service API keys to the browser".
- The browser only receives the normalized, secret-free `DashboardSnapshot`.

## ZFS access model

The dashboard never runs browser-controlled shell. Choose one of two safe modes
for ZFS data (PLA-184):

1. **Direct commands** (dashboard runs on the ZFS host). The collector executes
   a *fixed* argv — `zpool list -Hp -o name,size,alloc,free,health` and
   `zpool status` — via `execFile` with **no shell and no interpolation**. Grant
   the service user read-only `zpool` access (e.g. a sudoers rule limited to
   exactly those two commands); do **not** give it broad privileges.
2. **Host helper API** (dashboard is containerized away from ZFS). Run a minimal
   read-only helper on the host that returns the normalized pool JSON, and point
   `ZFS_COLLECTOR_URL` (+ optional `ZFS_COLLECTOR_TOKEN`) at it. The container
   needs no ZFS access at all.

Never mount broad host privileges into an internet-exposed container just to
read pool stats. Full deployment guidance lands in PLA-196.

## Privacy defaults

- No third-party analytics, telemetry, or remote fonts.
- `.env*` files are git-ignored; `.env.example` contains placeholders only.
- Connector errors are sanitized before reaching the client (enforced as real
  connectors are added in Milestone 02).

## Roadmap

See the Linear project for the full backlog. Near-term Milestone 01 work:

- **PLA-173** Visual design system & contrast
- **PLA-174** Ambient background & motion system
- **PLA-175** Responsive composition & progressive disclosure
- **PLA-176** Data-visualization primitives
- **PLA-177** Fake connector/state simulator
