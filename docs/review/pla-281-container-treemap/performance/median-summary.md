# PLA-281 final performance pass

Date: August 21, 2026

Warm-up note: `run-1/` was captured while another PR correction pass was still running screenshot/verify work in this repository. It is kept out of the final claim and is intentionally excluded from the medians below.

Harness: `npm run screenshots:kinetic:performance:prod -- --out docs/review/pla-281-container-treemap/performance/final-run-N`

Raw evidence:

- `final-run-1/performance-1920x1080.json`
- `final-run-2/performance-1920x1080.json`
- `final-run-3/performance-1920x1080.json`

Units: main-thread task milliseconds per wall second at 1920×1080, production build, headful Chromium.

| Profile | Run 1 | Run 2 | Run 3 | Median | Budget | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| quiet | 21.38 | 29.22 | 32.42 | 29.22 | 45 | pass |
| download | 97.26 | 56.04 | 73.00 | 73.00 | 110 | pass |
| playback | 91.98 | 83.64 | 87.88 | 87.88 | 110 | pass |
| transcode | 63.89 | 95.60 | 107.97 | 95.60 | 115 | pass |
| simultaneous | 94.01 | 85.92 | 87.84 | 87.84 | 120 | pass |
| 44-container | 107.49 | 92.53 | 81.46 | 92.53 | 130 | pass |
| 106-container | 124.16 | 147.11 | 122.93 | 124.16 | 155 | pass |
| attention | 32.11 | 36.99 | 41.37 | 36.99 | 110 | pass |
| inspector | 102.32 | 104.78 | 95.15 | 102.32 | 115 | pass |
| reduced-motion | 20.56 | 18.82 | 20.77 | 20.56 | 40 | pass |
| hidden-tab | 1.76 | 1.15 | 1.02 | 1.15 | 15 | pass |

The retained treemap plan cleared budget in all three uncontended final runs, so this pass made no code change.
