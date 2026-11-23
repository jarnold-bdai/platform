# Open follow-ups

Deferred items: known gaps that are not fixed yet, and what would settle each.

## A finished scan is not repeated on retry

`scanAndApply` (src/migrations/scanAndApply.ts) does not repeat a scan that finished, even if the plan was fixed in between. Decide after real migrations have run on staging: a per-migration option to re-plan from the start, or invalidating the checkpoint when the migration's code changes.

## No restart from scratch for a failed migration

There is no way to start a failed migration over. Add a CLI flag that clears the checkpoint of a `failed` migration; it must refuse a `running` or `applied` one.

## No test runs the expressions against DynamoDB

All tests use mocks. Add an opt-in suite against DynamoDB Local, or a recorded first run against a staging table. The first staging run should exercise claim, lease renewal, take-over, release and a conditional write.

## The read-only client has never run with a real `DynamoDBDocumentClient`

`readOnlyDynamo` (src/migrations/readOnlyClient.ts, the middleware at `context.commandName`) is only tested with `@aws-sdk/client-dynamodb` and mocks. `@aws-sdk/lib-dynamodb` is not installed here, so it has never run against a `DynamoDBDocumentClient`. If that client's commands report a different `commandName`, reads are refused in dry run and check. The first staging run settles it: run a dry run and a `--check` with a document client.

## AWS SDK peer dependencies are not optional

Add `peerDependenciesMeta` with `optional: true` for them. This needs the lockfile regenerated with registry access. No effect today.

## 7 vulnerabilities in dev dependencies

They are not identified. Run `npm audit` with registry access. Nothing ships them.

## Old-shape items written after a `pre` migration

They are caught only by the documented manual `post` sweep. Let a `pre` migration declare a follow-up sweep.

## CI has never run on GitHub

`ci.yml` and `publish.yml` are unproven until the first PR and the first tag.

## Workers should report a missing `node`

Workspace-level: unit 1's worker found no `node` on PATH. Workers should report a missing node instead of working around it.

## Stage 2, comms: switching to the shared schema

Switching is more than an import-path change; follow the recipe in src/agentConfig/README.md. Consider settling on one spelling (`...Z` or `...Zod`) once both apps import from the package.

The recipe's check was a one-off in a scratch project and cannot be reproduced from this repo. Adopting the shared schema in comms is what settles it.

## `SentClock` grows and freezes on a backward clock step

`SentClock` (src/migrations/history.ts) keeps one entry per (migrationId, runnerId) for the life of the `DynamoDbMigrationHistory` instance, so it grows in a long-lived process that reuses one instance with new runner ids (harmless in the CLI). After a large backward clock step it also freezes the sent time, so the stored lease stops moving while the runner's watchdog reads the stepped-back clock and fires later in real time than the stored lease ends. Prune entries when a claim ends, and decide how a large clock step should be handled (e.g. fail the attempt as clock skew).

## `runWrite` loses the lease-lost reason and leaves unawaited saves running

In `runWrite` (src/migrations/runner.ts), if the lease is lost after an interrupt, `ctx.signal.reason` stays the interrupt reason (the controller is already aborted). A migration that rethrows `ctx.signal.reason` is recorded failed with the interrupt message, not the lease-lost one. This is error text only: it is still failed and the claim is released. Also, a checkpoint save the migration did not await is not aborted when `run` returns (pre-existing). Record the lease-lost reason in the error when `lost` is aborted, and abort in-flight saves when the run ends.
