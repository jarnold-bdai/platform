import { randomUUID } from 'node:crypto';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { assertMode, assertPhase, validateMigrations } from './id.js';
import { isStale, type HistoryRecord, type HistoryStatus, type MigrationHistory } from './history.js';
import { readOnlyDynamo } from './readOnlyClient.js';
import { Report, SUMMARY_ENTRY_LIMIT, formatCounts } from './report.js';
import {
  LeaseLostError,
  UsageError,
  isUsageError,
  type CheckpointStore,
  type Logger,
  type Migration,
  type MigrationContext,
  type MigrationReport,
  type Mode,
  type Phase,
  type TableResolver,
} from './types.js';

/** A claim not renewed for this long may be taken over by another runner. */
export const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * A runner that cannot confirm a renewal stops this long before the stored
 * lease ends (a tenth of the lease), leaving room for clock skew between
 * runners and a late timer.
 */
const leaseMarginMs = (leaseMs: number): number => Math.max(1, Math.floor(leaseMs / 10));

/** Settles like `promise`, or rejects with the signal's reason once it aborts, even if `promise` never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface RunOptions {
  migrations: readonly Migration[];
  phase: Phase;
  mode: Mode;
  /** Run only this migration (it must be registered and of `phase`). With `check` it is checked even if applied. */
  only?: string;
  dynamo: DynamoDBClient;
  resolveTable: TableResolver;
  history: MigrationHistory;
  logger?: Logger;
  /** Lease length of a claim; default 5 minutes. */
  leaseMs?: number;
  /** How often the claim is renewed while a migration runs; default a fifth of the lease, and under nine tenths of it. */
  heartbeatMs?: number;
  /** The clock (for tests). */
  now?: () => Date;
  /** Identifies this runner in the history; default a random UUID. */
  runnerId?: string;
}

export type OutcomeStatus =
  /** write: ran cleanly and was recorded as applied. */
  | 'applied'
  /** Already recorded as applied; not run. */
  | 'already-applied'
  /** dry-run: ran cleanly; a `--write` run would apply and record it. */
  | 'would-apply'
  /** check: an applied migration (`only`) whose data has nothing left to do. */
  | 'check-passed'
  /** check: items still to write, or the migration is not recorded as applied. */
  | 'check-failed'
  /** Items were refused. Stops the run. */
  | 'refused'
  /** Conditional writes failed. Stops the run. */
  | 'conflict'
  /** `run` threw, or the claim was lost. Stops the run. */
  | 'failed'
  /** write: another runner holds a live claim on it. Stops the run. */
  | 'locked'
  /** Not run because an earlier migration stopped the run. */
  | 'not-run';

export interface MigrationOutcome {
  id: string;
  phase: Phase;
  description: string;
  status: OutcomeStatus;
  message?: string;
  report?: MigrationReport;
}

export interface UnregisteredRecord {
  migrationId: string;
  status: HistoryStatus;
  phase: Phase;
  finishedAt?: string;
}

export interface RunResult {
  phase: Phase;
  mode: Mode;
  only?: string;
  /** 0 nothing left to do; 1 work pending, refusals, conflicts, a failure or a failed check; 2 usage or AWS error. */
  exitCode: 0 | 1 | 2;
  migrations: MigrationOutcome[];
  /** History records whose id is not registered (e.g. a deleted migration file). Reported, not a failure. */
  unregistered: UnregisteredRecord[];
  /** The usage or AWS error that ended the run, if any. */
  error?: string;
}

const STOPS: ReadonlySet<OutcomeStatus> = new Set(['refused', 'conflict', 'failed', 'locked']);
const NOT_DONE: ReadonlySet<OutcomeStatus> = new Set([...STOPS, 'would-apply', 'check-failed', 'not-run']);

/** An error from AWS or from reaching it (service exception, credentials, network). */
export function isAwsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('$metadata' in error || '$fault' in error) return true;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (typeof name === 'string' && (/ProviderError$/.test(name) || name === 'TimeoutError')) return true;
  return typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

/** Exit 2 for a usage or AWS error, 1 for anything else a migration throws. */
const isHardError = (error: unknown): boolean => isUsageError(error) || isAwsError(error);

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const prefixed = (logger: Logger, prefix: string): Logger => ({
  info: (message) => logger.info(`${prefix} ${message}`),
  warn: (message) => logger.warn(`${prefix} ${message}`),
  error: (message) => logger.error(`${prefix} ${message}`),
});

/** A history record's status as `--list` shows it. */
export function describeStatus(record: HistoryRecord | undefined, now: Date): string {
  if (!record) return 'pending';
  if (isStale(record, now)) return `running, stale since ${record.leaseExpiresAt ?? '?'} (the next --write takes it over)`;
  if (record.status === 'running') return `running (claim held until ${record.leaseExpiresAt ?? '?'})`;
  return record.status;
}

/**
 * Runs the pending migrations of one phase (registered and not applied) in id
 * order, and stops at the first that fails, refuses an item, hits a conflict
 * or is locked by another runner. Never throws: errors become the result.
 */
export async function runMigrations(options: RunOptions): Promise<RunResult> {
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? (() => new Date());
  const result: RunResult = {
    phase: options.phase,
    mode: options.mode,
    ...(options.only !== undefined ? { only: options.only } : {}),
    exitCode: 0,
    migrations: [],
    unregistered: [],
  };
  let hardError = false;
  try {
    assertPhase(options.phase);
    assertMode(options.mode);
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 5));
    // The runner stops a tenth of the lease early when no renewal is confirmed,
    // so the first heartbeat has to go out before that.
    if (!(leaseMs > 0) || !(heartbeatMs > 0) || heartbeatMs >= leaseMs - leaseMarginMs(leaseMs)) {
      throw new UsageError('leaseMs and heartbeatMs must be positive, with heartbeatMs under nine tenths of leaseMs');
    }
    const registered = validateMigrations(options.migrations);
    const registeredIds = new Set(registered.map((m) => m.id));
    if (options.only !== undefined) {
      const target = registered.find((m) => m.id === options.only);
      if (!target) throw new UsageError(`--only ${options.only}: no registered migration has that id`);
      if (target.phase !== options.phase) {
        throw new UsageError(`--only ${options.only}: it is a ${target.phase} migration, not ${options.phase}`);
      }
    }

    const records = new Map((await options.history.list()).map((r) => [r.migrationId, r]));
    for (const record of records.values()) {
      if (registeredIds.has(record.migrationId)) continue;
      result.unregistered.push({
        migrationId: record.migrationId,
        status: record.status,
        phase: record.phase,
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      });
      logger.warn(`history has ${record.migrationId} (${record.status}), which is not registered`);
    }

    const selected = registered.filter((m) => m.phase === options.phase && (options.only === undefined || m.id === options.only));
    const runnerId = options.runnerId ?? randomUUID();
    let stopped = false;
    for (const migration of selected) {
      const base = { id: migration.id, phase: migration.phase, description: migration.description };
      if (stopped) {
        result.migrations.push({ ...base, status: 'not-run', message: 'an earlier migration stopped the run' });
        continue;
      }
      const record = records.get(migration.id);
      const recheck = options.mode === 'check' && options.only === migration.id;
      if (record?.status === 'applied' && !recheck) {
        result.migrations.push({ ...base, status: 'already-applied' });
        continue;
      }
      logger.info(`== ${migration.id} (${migration.phase}, ${options.mode}): ${migration.description}`);
      const run = options.mode === 'write'
        ? await runWrite(migration, { ...options, logger, now, leaseMs, heartbeatMs, runnerId })
        : await runReadOnly(migration, record, { ...options, logger });
      hardError ||= run.hardError;
      result.migrations.push({ ...base, ...run.outcome });
      const counts = run.outcome.report ? ` [${formatCounts(run.outcome.report)}]` : '';
      const line = `== ${migration.id}: ${run.outcome.status}${run.outcome.message ? ` (${run.outcome.message})` : ''}${counts}`;
      if (STOPS.has(run.outcome.status)) logger.error(line);
      else logger.info(line);
      if (STOPS.has(run.outcome.status)) stopped = true;
    }
  } catch (error) {
    hardError = true;
    result.error = errorText(error);
    logger.error(`ERROR ${result.error}`);
  }
  result.exitCode = hardError ? 2 : result.migrations.some((m) => NOT_DONE.has(m.status)) ? 1 : 0;
  return result;
}

interface RunOne {
  outcome: Omit<MigrationOutcome, 'id' | 'phase' | 'description'>;
  hardError: boolean;
}

function makeContext(
  migration: Migration,
  options: RunOptions & { logger: Logger },
  checkpoint: CheckpointStore,
  report: Report,
  signal: AbortSignal,
): MigrationContext {
  return {
    migrationId: migration.id,
    phase: migration.phase,
    mode: options.mode,
    // In dry-run and check the migration gets a client that refuses every write.
    dynamo: options.mode === 'write' ? options.dynamo : readOnlyDynamo(options.dynamo, options.mode),
    tableName: (logicalName) => {
      const name = options.resolveTable(logicalName);
      if (typeof name !== 'string' || name === '') throw new UsageError(`no table name for logical table ${logicalName}`);
      return name;
    },
    log: prefixed(options.logger, `[${migration.id}]`),
    checkpoint,
    report,
    signal,
  };
}

/** Outcome from the report and any error, shared by every mode. */
function problemOutcome(report: Report, error: unknown): RunOne | undefined {
  if (error !== undefined) {
    return { outcome: { status: 'failed', message: errorText(error), report: report.snapshot() }, hardError: isHardError(error) };
  }
  if (report.refusalCount > 0) {
    return { outcome: { status: 'refused', message: `${report.refusalCount} item(s) refused`, report: report.snapshot() }, hardError: false };
  }
  if (report.conflictCount > 0) {
    return { outcome: { status: 'conflict', message: `${report.conflictCount} conflict(s)`, report: report.snapshot() }, hardError: false };
  }
  return undefined;
}

/**
 * write: an item still reported pending at the end was not written, so the
 * migration is not done. It is recorded as failed (and retried by the next
 * `--write`), never as applied.
 */
function pendingInWrite(report: Report): RunOne | undefined {
  if (report.pendingCount === 0) return undefined;
  return {
    outcome: {
      status: 'failed',
      message: `${report.pendingCount} item(s) still pending after a write run: the migration reported writes it did not make, so it is not recorded as applied`,
      report: report.snapshot(),
    },
    hardError: false,
  };
}

async function runReadOnly(
  migration: Migration,
  record: HistoryRecord | undefined,
  options: RunOptions & { logger: Logger },
): Promise<RunOne> {
  const report = new Report();
  const slots: Record<string, unknown> = {};
  const checkpoint: CheckpointStore = {
    load: async <T>(slot: string) => structuredClone(slots[slot]) as T | undefined,
    save: async (slot, value) => {
      slots[slot] = structuredClone(value);
    },
  };
  let error: unknown;
  try {
    await migration.run(makeContext(migration, options, checkpoint, report, new AbortController().signal));
  } catch (caught) {
    error = caught ?? new Error('run threw an undefined value');
  }
  const problem = problemOutcome(report, error);
  if (problem) return problem;
  const snapshot = report.snapshot();
  const toWrite = `${report.pendingCount} item(s) to write`;
  if (options.mode === 'dry-run') return { outcome: { status: 'would-apply', message: toWrite, report: snapshot }, hardError: false };
  if (report.pendingCount > 0) return { outcome: { status: 'check-failed', message: toWrite, report: snapshot }, hardError: false };
  if (record?.status !== 'applied') {
    return {
      outcome: { status: 'check-failed', message: 'nothing to write, but not recorded as applied: run --write', report: snapshot },
      hardError: false,
    };
  }
  return { outcome: { status: 'check-passed', report: snapshot }, hardError: false };
}

async function runWrite(
  migration: Migration,
  options: RunOptions & { logger: Logger; now: () => Date; leaseMs: number; heartbeatMs: number; runnerId: string },
): Promise<RunOne> {
  const { history, now, leaseMs, heartbeatMs, runnerId, logger } = options;
  const claimedAt = now();
  const claim = await history.claim({
    migrationId: migration.id,
    phase: migration.phase,
    description: migration.description,
    runnerId,
    now: claimedAt,
    leaseMs,
  });
  if (!claim.claimed) {
    if (claim.current?.status === 'applied') {
      return { outcome: { status: 'already-applied', message: 'applied by another runner meanwhile' }, hardError: false };
    }
    const holder = claim.current
      ? `${claim.current.status} under runner ${claim.current.runnerId ?? '?'} until ${claim.current.leaseExpiresAt ?? '?'}`
      : 'claim refused';
    return { outcome: { status: 'locked', message: `another runner holds it: ${holder}` }, hardError: false };
  }
  if (claim.record.attempts > 1) {
    logger.info(`[${migration.id}] attempt ${claim.record.attempts}`
      + (claim.record.checkpoint ? ', resuming from its checkpoint' : ''));
  }

  const controller = new AbortController();
  /** Aborted when `run` returns, to drop a heartbeat still in flight. */
  const ended = new AbortController();
  const lose = (why: string) => {
    if (!controller.signal.aborted && !ended.signal.aborted) {
      logger.error(`[${migration.id}] ${why}; stopping`);
      controller.abort(new LeaseLostError(`${migration.id}: ${why}`));
    }
  };

  // The stored lease ends `leaseMs` after the `now` sent with the last renewal
  // the table accepted, so a renewal counts from when it was sent, not from
  // when its reply arrived. The history never lets a renewal shorten the
  // lease, so this end only moves later while the claim is held.
  let leaseEnd = claimedAt.getTime() + leaseMs;
  const renewed = (sentAt: Date) => {
    leaseEnd = Math.max(leaseEnd, sentAt.getTime() + leaseMs);
  };

  // The lease watchdog: on its own timer, whatever the heartbeat is doing,
  // abort `marginMs` before the stored lease can have ended.
  const marginMs = leaseMarginMs(leaseMs);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    const left = leaseEnd - marginMs - now().getTime();
    if (left <= 0) {
      lose('could not renew the claim before its lease ran out');
      return;
    }
    watchdog = setTimeout(watch, left);
    watchdog.unref?.();
  };

  // Renewals (heartbeats and checkpoint saves) go out one at a time, so a
  // reply always answers the newest renewal: a refusal then means the claim
  // was lost, not that an older renewal was overtaken by a newer one.
  let renewing: Promise<unknown> = Promise.resolve();
  let busy = 0;
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    busy += 1;
    const result = renewing.then(task).finally(() => {
      busy -= 1;
    });
    renewing = result.catch(() => undefined);
    return result;
  };

  // A heartbeat not answered within half an interval is abandoned (its
  // request aborted), so a hung request never blocks the next one.
  const heartbeatTimeoutMs = Math.max(1, Math.floor(heartbeatMs / 2));
  const beat = async (): Promise<void> => {
    const sentAt = now();
    const request = new AbortController();
    const cancel = (reason: unknown) => () => request.abort(reason);
    const timeout = setTimeout(cancel(new Error(`heartbeat timed out after ${heartbeatTimeoutMs} ms`)), heartbeatTimeoutMs);
    timeout.unref?.();
    const onLost = cancel(controller.signal.reason);
    const onEnded = cancel(new Error('the migration ended'));
    controller.signal.addEventListener('abort', onLost, { once: true });
    ended.signal.addEventListener('abort', onEnded, { once: true });
    try {
      const held = await untilAborted(history.heartbeat(migration.id, runnerId, sentAt, leaseMs, request.signal), request.signal);
      if (held) renewed(sentAt);
      else lose('lost the claim (another runner took it over)');
    } catch (error) {
      if (!controller.signal.aborted && !ended.signal.aborted) {
        logger.warn(`[${migration.id}] heartbeat failed: ${errorText(error)}`);
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onLost);
      ended.signal.removeEventListener('abort', onEnded);
    }
  };
  const timer = setInterval(() => {
    if (busy > 0 || controller.signal.aborted) return;
    void exclusive(beat);
  }, heartbeatMs);
  timer.unref?.();
  watch();

  const slots: Record<string, unknown> = structuredClone(claim.record.checkpoint ?? {});
  const checkpoint: CheckpointStore = {
    load: async <T>(slot: string) => structuredClone(slots[slot]) as T | undefined,
    save: (slot, value) => exclusive(async () => {
      controller.signal.throwIfAborted();
      slots[slot] = structuredClone(value);
      const sentAt = now();
      await untilAborted(
        history.saveCheckpoint(migration.id, runnerId, slots, sentAt, leaseMs, controller.signal),
        controller.signal,
      );
      renewed(sentAt);
    }),
  };

  const report = new Report();
  let error: unknown;
  try {
    await migration.run(makeContext(migration, options, checkpoint, report, controller.signal));
  } catch (caught) {
    error = caught ?? new Error('run threw an undefined value');
  } finally {
    clearInterval(timer);
    clearTimeout(watchdog);
    ended.abort();
  }
  if (error === undefined && controller.signal.aborted) error = controller.signal.reason;

  const problem = problemOutcome(report, error) ?? pendingInWrite(report);
  const status = problem ? 'failed' : 'applied';
  try {
    await history.finish(migration.id, runnerId, {
      status,
      now: now(),
      summary: report.snapshot(SUMMARY_ENTRY_LIMIT),
      ...(problem?.outcome.message ? { error: problem.outcome.message } : {}),
    });
  } catch (finishError) {
    if (problem) {
      logger.error(`[${migration.id}] could not record the failure: ${errorText(finishError)}`);
      return { ...problem, hardError: problem.hardError || isHardError(finishError) };
    }
    return {
      outcome: { status: 'failed', message: `ran, but could not record it as applied: ${errorText(finishError)}`, report: report.snapshot() },
      hardError: isHardError(finishError),
    };
  }
  return problem ?? { outcome: { status: 'applied', report: report.snapshot() }, hardError: false };
}
