import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDbMigrationHistory, type HistoryRecord, type MigrationHistory } from './history.js';
import { validateMigrations } from './id.js';
import { formatCounts } from './report.js';
import { consoleLogger, describeStatus, errorText, runMigrations, type RunResult } from './runner.js';
import { PHASES, UsageError, type Logger, type Migration, type Mode, type Phase, type TableResolver } from './types.js';

export interface MigrateCliOptions {
  migrations: readonly Migration[];
  /** Constructed by the consumer (region, credentials); the library never creates one. */
  dynamo: DynamoDBClient;
  /** Logical table name -> real table name in this environment. */
  resolveTable: TableResolver;
  /** The real name of the history table. Required unless `history` is given. */
  historyTable?: string;
  /** A history to use instead of the DynamoDB one over `historyTable` (tests, local runs). */
  history?: MigrationHistory;
  logger?: Logger;
  /** The command shown in the usage text; default `npx tsx scripts/migrate.ts`. */
  command?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
}

export interface MigrateCli {
  /**
   * Parses `argv` (without the node and script paths), runs, and returns the exit code. Never throws.
   * Aborting `signal` stops the run: see `RunOptions.signal`.
   */
  run(argv: readonly string[], signal?: AbortSignal): Promise<number>;
  /** `run(process.argv.slice(2))`, then sets `process.exitCode`. */
  main(): Promise<void>;
}

const usageText = (command: string): string => `Usage:
  ${command} --phase pre|post [--write | --check] [--only <id>] [--json <file>]
  ${command} --list [--phase pre|post] [--json <file>]

  (no mode)   dry run: report what would be done; writes nothing, records nothing
  --write     apply the pending migrations of the phase and record them
  --check     read-only: passes only when nothing is left to do
  --only <id> just this migration (with --check, also when already applied)
  --list      show each migration's history status
  --json <f>  write the full report to <f>

Exit codes: 0 nothing left to do; 1 work pending, refusals, conflicts, a failure or a failed check; 2 usage or AWS error.`;

const OPTIONS = {
  phase: { type: 'string' },
  write: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  only: { type: 'string' },
  list: { type: 'boolean', default: false },
  json: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** The part of `process` that `handleInterrupts` needs. */
export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * On the first SIGINT or SIGTERM, aborts `controller` with an error naming the
 * signal, so the runner records the running migration as `failed` (releasing
 * its claim, keeping its checkpoint) before the process exits. A second signal
 * calls `force` (default: exit at once, with 128 plus the signal number).
 * Returns a function that removes the handlers, and tells which signal came.
 */
export function handleInterrupts(
  controller: AbortController,
  source: SignalSource,
  logger: Logger,
  force: (code: number) => void = (code) => process.exit(code),
): { dispose(): void; received(): NodeJS.Signals | undefined } {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGTERM: 15 };
  let first: NodeJS.Signals | undefined;
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((name) => {
    const handler = () => {
      if (first) {
        logger.error(`${name} again: exiting without waiting`);
        force(128 + (numbers[name] ?? 0));
        return;
      }
      first = name;
      logger.warn(`${name} received: stopping the running migration and recording it as failed (send it again to exit at once)`);
      controller.abort(new Error(`interrupted by ${name}`));
    };
    source.on(name, handler);
    return [name, handler] as const;
  });
  return {
    dispose: () => handlers.forEach(([name, handler]) => source.off(name, handler)),
    received: () => first,
  };
}

export function createMigrateCli(options: MigrateCliOptions): MigrateCli {
  const logger = options.logger ?? consoleLogger;
  const command = options.command ?? 'npx tsx scripts/migrate.ts';

  const usage = (message: string): number => {
    logger.error(`${message}\n${usageText(command)}`);
    return 2;
  };

  const historyOf = (): MigrationHistory => {
    if (options.history) return options.history;
    if (!options.historyTable) throw new UsageError('no history table name configured (historyTable)');
    return new DynamoDbMigrationHistory({ dynamo: options.dynamo, tableName: options.historyTable });
  };

  const writeJson = (path: string | undefined, value: unknown): boolean => {
    if (path === undefined) return true;
    try {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      logger.info(`Wrote the report to ${path}`);
      return true;
    } catch (error) {
      logger.error(`could not write --json ${path}: ${errorText(error)}`);
      return false;
    }
  };

  const list = async (phase: Phase | undefined, json: string | undefined): Promise<number> => {
    let records: Map<string, HistoryRecord>;
    let registered: Migration[];
    try {
      registered = validateMigrations(options.migrations).filter((m) => phase === undefined || m.phase === phase);
      records = new Map((await historyOf().list()).map((r) => [r.migrationId, r]));
    } catch (error) {
      logger.error(`ERROR ${errorText(error)}`);
      return 2;
    }
    const now = (options.now ?? (() => new Date()))();
    const registeredIds = new Set(options.migrations.map((m) => m.id));
    const rows = registered.map((m) => {
      const record = records.get(m.id);
      return { id: m.id, phase: m.phase, description: m.description, status: describeStatus(record, now), record };
    });
    const unregistered = [...records.values()]
      .filter((r) => !registeredIds.has(r.migrationId) && (phase === undefined || r.phase === phase))
      .sort((a, b) => (a.migrationId < b.migrationId ? -1 : 1));
    logger.info(`Migrations${phase ? ` (${phase})` : ''}:`);
    for (const row of rows) {
      const when = row.record?.finishedAt ?? row.record?.startedAt;
      logger.info(`  ${row.id}  ${row.phase}  ${row.status}${when ? `  ${when}` : ''}  ${row.description}`);
      if (row.record?.error) logger.info(`      last error: ${row.record.error}`);
    }
    if (rows.length === 0) logger.info('  (none registered)');
    for (const record of unregistered) {
      logger.warn(`  ${record.migrationId}  ${record.phase}  ${record.status}  NOT REGISTERED (in the history only)`);
    }
    return writeJson(json, { registered: rows, unregistered }) ? 0 : 2;
  };

  const printResult = (result: RunResult): void => {
    const label = { 'dry-run': 'DRY RUN', write: 'WRITE', check: 'CHECK' }[result.mode];
    logger.info(`\nMigrations, phase ${result.phase}, ${label}${result.only ? `, only ${result.only}` : ''}:`);
    if (result.migrations.length === 0 && !result.error) logger.info('  (none registered for this phase)');
    for (const m of result.migrations) {
      const counts = m.report ? formatCounts(m.report) : '';
      logger.info(`  ${m.id}  ${m.status}${m.message ? `: ${m.message}` : ''}${counts ? `  [${counts}]` : ''}`);
      for (const r of m.report?.refusals.slice(0, 20) ?? []) logger.info(`      refused ${r.item}: ${r.detail}`);
      for (const c of m.report?.conflicts.slice(0, 20) ?? []) logger.info(`      conflict ${c.item}: ${c.detail}`);
    }
    for (const u of result.unregistered) {
      logger.warn(`  note: the history has ${u.migrationId} (${u.status}) but it is not registered`);
    }
    if (result.error) logger.error(`  error: ${result.error}`);
    const why = result.exitCode === 0
      ? 'nothing left to do'
      : result.exitCode === 2
        ? 'usage or AWS error'
        : result.mode === 'dry-run'
          ? 'work is pending (dry run: nothing written; re-run with --write), or see the lines above'
          : result.mode === 'check' ? 'check failed' : 'not everything was applied; see the lines above';
    logger.info(`Exit ${result.exitCode}: ${why}`);
  };

  const run = async (argv: readonly string[], signal?: AbortSignal): Promise<number> => {
    let values;
    try {
      values = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values;
    } catch (error) {
      return usage(errorText(error));
    }
    if (values.help) {
      logger.info(usageText(command));
      return 0;
    }
    const phase = values.phase;
    if (phase !== undefined && !PHASES.includes(phase as Phase)) return usage(`--phase must be one of ${PHASES.join(', ')}`);
    if (values.list) {
      if (values.write || values.check || values.only !== undefined) return usage('--list takes no --write, --check or --only');
      return list(phase as Phase | undefined, values.json);
    }
    if (phase === undefined) return usage('--phase is required');
    if (values.write && values.check) return usage('--check is read-only; it cannot be combined with --write');
    const mode: Mode = values.write ? 'write' : values.check ? 'check' : 'dry-run';

    let history: MigrationHistory;
    try {
      history = historyOf();
    } catch (error) {
      return usage(errorText(error));
    }
    const result = await runMigrations({
      migrations: options.migrations,
      phase: phase as Phase,
      mode,
      ...(values.only !== undefined ? { only: values.only } : {}),
      dynamo: options.dynamo,
      resolveTable: options.resolveTable,
      history,
      logger,
      ...(signal ? { signal } : {}),
      ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    printResult(result);
    return writeJson(values.json, result) ? result.exitCode : 2;
  };

  const safeRun = async (argv: readonly string[], signal?: AbortSignal): Promise<number> => {
    try {
      return await run(argv, signal);
    } catch (error) {
      logger.error(`ERROR ${errorText(error)}`);
      return 2;
    }
  };
  return {
    run: safeRun,
    main: async () => {
      const controller = new AbortController();
      const interrupts = handleInterrupts(controller, process, logger);
      try {
        const code = await safeRun(process.argv.slice(2), controller.signal);
        const signal = interrupts.received();
        // A run that finished cleanly keeps its own result; any other result
        // after a signal is the conventional 128 + signal number.
        process.exitCode = signal && code !== 0 ? 128 + (signal === 'SIGINT' ? 2 : 15) : code;
      } finally {
        interrupts.dispose();
      }
    },
  };
}
