# @jarnold-bdai/platform

Code shared by the bdai apps (comms `bdai-mvp-1`, the compliator `bdai-twilio-isv-compliator`, the UI `bdai-mvp-ui-1`), published as a private package on GitHub Packages. It ships CommonJS and ESM builds with types.

## Subpaths

There is no root entry point; import one of:

- `@jarnold-bdai/platform/migrations`: the DynamoDB migration runner. The caller passes in the DynamoDB client. See [src/migrations/README.md](src/migrations/README.md).
- `@jarnold-bdai/platform/agentConfig`: Zod schemas stored by more than one app. Safe for the web app: it never imports the AWS SDK. How comms and the UI switch to it from their own copies: [src/agentConfig/README.md](src/agentConfig/README.md).

Peer dependencies: `zod` ^3, `@aws-sdk/client-dynamodb` and `@aws-sdk/util-dynamodb` (v3).

## Install (consumers)

Add to the consumer's `.npmrc` (committed; it holds no secret):

```
@jarnold-bdai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

Export `NPM_TOKEN` as a GitHub token with `read:packages` (in CI, `GITHUB_TOKEN` with `packages: read`). Never commit the token. Then:

```
npm install @jarnold-bdai/platform
```

## Develop

```
npm ci
npm run typecheck
npm test
npm run build
npm run verify:exports   # after build: resolves both subpaths from CJS and ESM
```

## Release

1. Bump `version` in `package.json` (e.g. `npm version minor --no-git-tag-version`) and merge to `main`.
2. Tag `vX.Y.Z` on that commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The publish workflow fails unless the tag equals the `package.json` version, then runs tests, builds and publishes.
