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

The publish workflow fails unless the tag equals the `package.json` version, then runs the same checks as CI (typecheck, tests, build, `verify:exports`) and publishes.

### Staging builds

A push to `staging` publishes `<version>-staging.<run number>` (for example `0.1.1-staging.7`) under the dist-tag `staging`. `latest` is never moved by a staging build.

Consumers' staging builds install it with `npm install --no-save @jarnold-bdai/platform@staging`, while `package.json` in each app keeps an exact released version.

Changes to this repo go to `staging` first and reach `main` by a later merge. A release is still a version bump on `main` plus a `v*` tag.

Re-running a finished staging publish run fails because that version already exists (GitHub Packages versions cannot be overwritten). Push again to publish a new one.
