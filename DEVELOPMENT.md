# Development

## Setup

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the plugin:
   ```bash
   npm run build
   ```
4. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-smart-sync/`

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Development (watch)
npm run build      # Production build (tsc -noEmit && esbuild)
npm test           # Run tests (vitest)
npm run test:watch # Tests in watch mode
npm run lint       # Lint (eslint ./src/)
```

## Build artifacts

`main.js`, `manifest.json`, `styles.css` are placed in the vault's `.obsidian/plugins/obsidian-smart-sync/`. Never commit `node_modules/` or `main.js`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical design.

## Coding conventions

- TypeScript strict mode
- `main.ts` handles lifecycle only; delegate logic to separate modules
- Split files at ~200–300 lines
- Register listeners via `this.register*` (prevent leaks)
- Prefer `async/await`
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs
- Minimize network calls; require explicit disclosure
- Command IDs are immutable once published

## Releases

Update `version` in `manifest.json` (SemVer, no `v` prefix) and `versions.json`. GitHub release tag must match the version exactly.
