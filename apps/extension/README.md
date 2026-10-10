# @job-newtab/extension

The MV3 browser extension (WXT + React). See the [root README](../../README.md) for setup and [ARCHITECTURE.md](../../ARCHITECTURE.md) for how it fits together.

```bash
pnpm build       # → .output/chrome-mv3
pnpm dev         # hot-reload dev build
pnpm typecheck
```

- `entrypoints/background.ts`: the service worker that hosts the build
- `entrypoints/scraper.content.ts`: injected into board search pages to scroll and return their HTML
- `entrypoints/newtab/`: onboarding, the job board and tracker, settings
- `lib/`: the build manager, scraper, storage and the page↔worker protocol
