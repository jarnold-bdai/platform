# Migrations (`@jarnold-bdai/platform/migrations`)

A shared runner for DynamoDB data migrations. Each app registers its migrations, and its deploy runs:

```
migrate --phase pre --write   ->   deploy   ->   migrate --phase post --write
```

The runner records what was applied where in a history table, so a migration runs once per environment. A re-run is always safe.

## Writing a migration

One file per migration, exporting a `Migration`:

```ts
import { scanAndApply, unchangedCondition, type Migration, type PlanResult, type Item } from '@jarnold-bdai/platform/migrations';

/** Pure, unit-tested: what to do with one item. No IO. */
export function plan(item: Item): PlanResult {
  if (item.configFormat !== undefined) return { action: 'skip' };          // already in the target state
  if (item.configuration?.M === undefined) return { action: 'refuse', reason: 'configuration is not a map' };
  return {
    action: 'write',
    detail: 'configFormat=legacy',
    write: {
      kind: 'update',
      key: { pk: item.pk!, sk: item.sk! },
      updateExpression: 'SET #configFormat = :legacy',
      names: { '#configFormat': 'configFormat' },
      values: { ':legacy': { S: 'legacy' } },
      // Fails if the item changed since it was scanned (or was deleted).
      condition: unchangedCondition(item, ['pk', 'configFormat', 'updatedAt']),
    },
  };
}

export const migration: Migration = {
  id: '20261121-0930-add-config-format',
  phase: 'pre',
  description: 'Mark every AiConfiguration item configFormat=legacy',
  run: async (ctx) => {
    await scanAndApply(ctx, { table: 'AiConfiguration', key: ['pk', 'sk'], plan });
  },
};
```

Rules for authors:

- **Ids** are `YYYYMMDD-HHMM-kebab-slug`, the UTC date and time you wrote the migration (e.g. `20261121-0930-add-config-format`). Migrations run in lexical order of id, which this fixed-width prefix makes chronological. Ids must be unique, and an id is never reused or renamed once applied anywhere: the history knows migrations by id.
- **Never change an applied migration.** To redo or fix one, add a new migration.
- **`plan` must be pure** and return `skip` for an item it has already written, so a re-run (after a crash, conflict or refusal) does nothing twice. Keep it in its own module with unit tests, as the existing scripts do.
- **Every write needs a condition** that fails if the item changed since it was scanned: `unchangedCondition(item, [key, ...the attributes you read])` for updates, puts over an existing item and deletes; `absentCondition(hashKey)` for a put that creates an item. A failed condition is reported as a conflict, never retried blindly.
- **Use `#name` placeholders** in every expression (update, condition, filter).
- **Refuse, don't guess.** Return `refuse` with a reason for anything ambiguous or malformed. A refused item is never written and stops the run until someone resolves it.
- Tables are logical names (`ctx.tableName('AiConfiguration')`); the consumer's resolver maps them to the real names in each environment.
- A migration that doesn't fit the scan helper can use the context directly (`ctx.dynamo`, `ctx.mode`, `ctx.report`, `ctx.checkpoint`, `ctx.signal`). It must call `ctx.report.pending(item)` for each write it would make in dry run and check, and stop when `ctx.signal` aborts. Read-only modes are enforced: in dry run and check, `ctx.dynamo` wraps the caller's client and refuses every command that could write (`PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `TransactWriteItems`, PartiQL other than `SELECT`, table management, and any command it does not know) with a `ReadOnlyModeError` naming the mode and the command, which fails the migration. Reads (`GetItem`, `BatchGetItem`, `Query`, `Scan`, `TransactGetItems`, `Describe*`, `List*`, PartiQL `SELECT`) go through. A client built on it, such as `DynamoDBDocumentClient.from(ctx.dynamo)`, is guarded the same way. So check `ctx.mode` before writing; a write in a dry run is a bug the run reports, not a write.

## Phases: `pre` and `post`

|        | runs                                   | serving code       | may                                                                     |
|--------|----------------------------------------|--------------------|-------------------------------------------------------------------------|
| `pre`  | before the deploy                      | the **old** code   | **add only**: new attributes, new items, copies the old code ignores    |
| `post` | after the deploy has finished          | the new code       | remove, rename or rewrite what only the old code needed                 |

A `pre` migration must be safe for the old code that keeps serving until the deploy finishes, and for a rollback to it. Never remove, rename, retype or change the meaning of an attribute or item the old code reads or writes. The library cannot check this; review it.

The old code keeps writing while and after a `pre` migration runs, until the deploy is done, so items in the old shape can appear after it was applied. If that matters, make the new code handle both shapes, and add a `post` migration with the same `plan` (a new id) to catch the stragglers. An applied migration is never re-run by `--write`. `--check --only <id>` re-verifies one after the deploy.

## Modes and exit codes

| flag        | mode      | data           | history                         |
|-------------|-----------|----------------|---------------------------------|
| (none)      | `dry-run` | read only (enforced) | read only                 |
| `--write`   | `write`   | conditional writes | claims, checkpoints, records |
| `--check`   | `check`   | read only (enforced) | read only                 |

In dry run and check the runner only lists the history (one `Scan`); it never claims, renews, checkpoints or records, and checkpoint saves stay in memory.

The runner takes the registered migrations of the phase that are not `applied` in the history, in id order. It stops at the first one that fails, refuses an item, hits a conflict, or is held by another runner. The later ones are listed as `not-run`.

- **dry run**: runs each pending migration read-only and reports what it would write or refuse. `scanAndApply` validates every planned write in every mode (a condition is present; every `#name` and `:value` placeholder is defined and every defined one is used), so a write that `--write` would reject fails the dry run and the check the same way, before anything is written.
- **write**: claims each pending migration, runs it, and records it `applied`, or `failed` with the reason. Items that can be written are written even when other items are refused or conflict; the migration then stays unapplied, and the next `--write` retries it from its checkpoint. A migration that still reports pending items (`ctx.report.pending`) at the end of a write run has not written them, so it is recorded `failed` (exit 1), never `applied`.
- **check**: passes only when nothing is left to do: no pending migration and nothing to write or refuse. A pending migration fails the check even if its data needs no write, because it still has to be recorded. With `--only <id>`, an applied migration is checked against the data again.

Exit codes:

- `0`: nothing left to do.
- `1`: work is pending (dry run), or there were refusals, conflicts, a failure, a claim held by another runner, or a failed check.
- `2`: a usage error (bad flags, invalid or duplicate ids, an unresolved table name, no history table) or an AWS error (including credentials and network).

A history record whose id is no longer registered (e.g. a deleted file) is reported as a warning and never fails the run.

## The history table

One DynamoDB table per environment, named by the consumer: hash key `migrationId` (S), no sort key, on-demand billing. The runner needs `dynamodb:GetItem`, `Scan` and `UpdateItem` on it. One item per migration:

| attribute        | type | meaning                                                                         |
|------------------|------|---------------------------------------------------------------------------------|
| `migrationId`    | S    | the migration's id                                                              |
| `status`         | S    | `running`, `applied` or `failed`                                                |
| `phase`          | S    | `pre` or `post`                                                                 |
| `description`    | S    | from the definition                                                             |
| `startedAt`      | S    | ISO time the current or last attempt started                                    |
| `finishedAt`     | S    | ISO time the last attempt ended (absent while running)                          |
| `heartbeatAt`    | S    | last renewal of the claim                                                       |
| `leaseExpiresAt` | S    | the claim lapses after this ISO time (absent once finished)                     |
| `runnerId`       | S    | random id of the runner that holds, or last held, the claim                     |
| `attempts`       | N    | how many times it was claimed                                                   |
| `checkpoint`     | M    | the migration's checkpoint slots; kept on failure, removed once applied         |
| `summary`        | M    | the last attempt's counts, with the first 20 refusals, conflicts and pending items |
| `error`          | S    | why the last attempt failed                                                     |

**Claim.** In write mode a migration is claimed with one conditional `UpdateItem`. It succeeds only if the item is absent, `failed`, or `running` with `leaseExpiresAt` in the past. What this guarantees: only one runner holds the claim at a time, and a second runner that finds a live claim gets `locked` (exit 1). A runner that cannot renew its lease aborts `ctx.signal` before the lease ends (see below), so it has stopped before another runner can take the migration over. And every data write is conditional, so if a stalled runner does overlap with the next one, the overlap cannot corrupt items: a write over a changed item fails as a conflict.

**Crashed runners.** The claim is a lease, 5 minutes by default (`leaseMs`). While a migration runs, the runner renews it every minute (`heartbeatMs`, a fifth of the lease; it must be under nine tenths of it), and every checkpoint save renews it too. A crashed or killed runner stops renewing, and once the lease has lapsed the next `--write` takes the migration over and resumes from its checkpoint. You never edit the table by hand: wait out the lease, then re-run. `--list` shows such a claim as `running, stale since …`. Every write a runner makes to the history is conditional on it still holding the claim.

**Losing the lease.** A renewal sets the lease to `leaseMs` after the time the runner sent it, and the runner counts its lease from that send time, not from when the reply came. A watchdog timer, independent of the heartbeat, aborts `ctx.signal` a tenth of the lease before the last confirmed renewal's lease ends; the migration then fails and the next `--write` resumes it. Renewals go out one at a time, and a heartbeat that gets no reply within half an interval is abandoned (its request aborted), so a hung request delays nothing. A renewal never shortens the stored lease: one that reaches the table after a later one (an abandoned request, say) fails its condition. A runner whose claim was taken over learns it at its next heartbeat or checkpoint save, aborts `ctx.signal` and stops. A migration must stop when `ctx.signal` aborts; `scanAndApply` checks it before every page and item.

**Checkpoints.** In write mode `scanAndApply` saves the Scan's position (`LastEvaluatedKey`) in its slot after each page (`pageSize`, default 100). A re-run of a failed or crashed attempt resumes from there, and a finished scan is not repeated. Once an item has been refused or has conflicted, the checkpoint stops advancing. The re-run after the fix therefore scans that item again, while items already written are skipped by `plan`. Dry run and check ignore checkpoints and always scan everything.

## Wiring the CLI in a consuming repo

`scripts/migrate.ts`:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createMigrateCli } from '@jarnold-bdai/platform/migrations';
import { migrations } from '../migrations/index.js'; // the app's registered Migration[]

const tables: Record<string, string | undefined> = {
  AiConfiguration: process.env.AI_CONFIG_TABLE,
  BusinessSettings: process.env.BUSINESS_SETTINGS_TABLE,
};

await createMigrateCli({
  migrations,
  dynamo: new DynamoDBClient({}),
  resolveTable: (name) => tables[name],
  historyTable: process.env.MIGRATION_HISTORY_TABLE,
}).main();
```

```
AWS_PROFILE=<profile> npx tsx scripts/migrate.ts --phase pre                # dry run
AWS_PROFILE=<profile> npx tsx scripts/migrate.ts --phase pre --write
AWS_PROFILE=<profile> npx tsx scripts/migrate.ts --phase post --check --json report.json
AWS_PROFILE=<profile> npx tsx scripts/migrate.ts --list
```

Flags: `--phase pre|post` (required except with `--list`), `--write`, `--check`, `--only <id>`, `--list` (history status of each registered migration, plus history-only ids), `--json <file>` (the full report), `--help`. Unknown flags are a usage error. To pass app flags (e.g. a stage), strip them from `process.argv` and call `cli.run(rest)` instead of `main()`.

For tests, pass `history: new InMemoryMigrationHistory()` instead of `historyTable`, or call `runMigrations` directly.
