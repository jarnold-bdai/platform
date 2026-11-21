# platform

Private npm package `@jarnold-bdai/platform`, shared by three apps (comms, compliator, UI).

## Commands
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run verify:exports` (after build: resolves both subpaths from CJS and ESM)

## Rules
- Two subpaths only: `migrations` (`src/migrations/index.ts`) and `agentConfig` (`src/agentConfig/index.ts`). No root entry point that re-exports both. A new subpath needs `exports` and `typesVersions` entries in `package.json`.
- The DynamoDB client is always a parameter, never constructed inside the library.
- No AWS SDK import under `src/agentConfig` (the web app imports it).
- Relative imports use a `.js` extension (e.g. `./foo.js`) so the output works as native ESM.
- No new runtime dependencies; dependencies are already declared in `package.json`.

## Open follow-ups
- Known gaps and deferred decisions are listed in `docs/open-followups.md`. Check it before starting related work, and add to it when you defer something.
