# PLA-281 final performance pass

Date: August 21, 2026

The initial uncontended reproduction passed on the isolated PLA-281 branch, but the first three-run synthetic-integration profile reproduced small median misses for download, 44 containers, and 106 containers. The retained-plan hot path was therefore optimized before these final measurements: weight-only frames reuse the plan's leaf/rectangle indexes, and unchanged DOM hitbox geometry is no longer rewritten.

Harness: `npm run screenshots:kinetic:performance:prod -- --out docs/review/pla-281-container-treemap/performance/final-run-N`

Raw evidence:

- `final-run-1/performance-1920x1080.json`
- `final-run-2/performance-1920x1080.json`
- `final-run-3/performance-1920x1080.json`

Units: main-thread task milliseconds per wall second at 1920×1080, production build, headful Chromium.

| Profile | Run 1 | Run 2 | Run 3 | Median | Budget | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| quiet | 35.96 | 34.51 | 32.57 | 34.51 | 45 | pass |
| download | 92.31 | 90.24 | 90.08 | 90.24 | 110 | pass |
| playback | 88.53 | 90.32 | 91.11 | 90.32 | 110 | pass |
| transcode | 98.27 | 101.52 | 103.61 | 101.52 | 115 | pass |
| simultaneous | 96.21 | 95.64 | 97.30 | 96.21 | 120 | pass |
| 44-container | 114.89 | 117.60 | 119.87 | 117.60 | 130 | pass |
| 106-container | 137.06 | 144.19 | 143.08 | 143.08 | 155 | pass |
| attention | 38.95 | 33.21 | 33.80 | 33.80 | 110 | pass |
| inspector | 89.53 | 91.53 | 90.63 | 90.63 | 115 | pass |
| reduced-motion | 21.62 | 21.33 | 18.46 | 21.33 | 40 | pass |
| hidden-tab | 1.56 | 1.62 | 1.69 | 1.62 | 15 | pass |

All three post-optimization production/headful runs cleared every existing budget without changing frame cadence, interpolation, telemetry truth, treemap topology, or hit-target alignment.
