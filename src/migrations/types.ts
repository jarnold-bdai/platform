import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';

/** A DynamoDB item in the low-level format (`{ attr: { S: '…' } }`). */
export type Item = Record<string, AttributeValue>;

/**
 * `pre` runs before the new code deploys, while the old code is still serving,
 * so it must be additive only: add attributes, items or copies the old code
 * ignores; never remove, rename or change the meaning of anything the old code
 * reads. `post` runs after the deploy, when only the new code is serving, and
 * may remove what the old code needed.
 */
export type Phase = 'pre' | 'post';
export const PHASES: readonly Phase[] = ['pre', 'post'];

/**
 * - `dry-run` (the default): plan and report; no write to the data or to the history.
 * - `write`: apply, and record the migration in the history.
 * - `check`: read-only; passes only when nothing is left to do.
 */
export type Mode = 'dry-run' | 'write' | 'check';
export const MODES: readonly Mode[] = ['dry-run', 'write', 'check'];

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Maps a logical table name (e.g. `BusinessSettings`) to the real one in this environment. */
export type TableResolver = (logicalName: string) => string | undefined;

/**
 * Progress a migration keeps between attempts, in named slots. Values must be
 * plain data (objects, arrays, strings, numbers, booleans, null, Uint8Array)
 * and small: they are stored on the migration's history item.
 *
 * Only `write` mode persists saves. In `dry-run` and `check` the store starts
 * empty and saves stay in memory, so those modes always look at everything.
 */
export interface CheckpointStore {
  load<T = unknown>(slot: string): Promise<T | undefined>;
  save(slot: string, value: unknown): Promise<void>;
}

/** Collects what a migration did or would do. The runner decides the outcome from it. */
export interface ReportCollector {
  /** Adds to a named counter (`scanned`, `skipped`, `written`, or anything else). */
  count(name: string, by?: number): void;
  /**
   * An item that still needs a write (dry run / check). Counted as `pending`;
   * a check with any pending item fails. In `write` mode, call it only for an
   * item you did not write: any pending item makes the run record the
   * migration as failed, not applied.
   */
  pending(item: string, detail?: string): void;
  /** An item the migration will not write (bad data, ambiguous case). Stops the run. */
  refuse(item: string, reason: string): void;
  /** A write whose condition failed (the item changed since it was read). Stops the run. */
  conflict(item: string, detail: string): void;
}

export interface MigrationContext {
  readonly migrationId: string;
  readonly phase: Phase;
  readonly mode: Mode;
  /** The caller's client (the library never constructs one); in `dry-run` and `check`, wrapped so that every write is refused. */
  readonly dynamo: DynamoDBClient;
  /** The real name of a logical table; throws a usage error when the consumer's resolver has none. */
  tableName(logicalName: string): string;
  readonly log: Logger;
  readonly checkpoint: CheckpointStore;
  readonly report: ReportCollector;
  /** Aborted when this runner has lost its claim, or could not renew it before its lease ends; stop writing when it fires. */
  readonly signal: AbortSignal;
}

export interface Migration {
  /** `YYYYMMDD-HHMM-kebab-slug` (UTC), e.g. `20261121-0930-add-config-format`. See `validateMigrationId`. */
  readonly id: string;
  readonly phase: Phase;
  readonly description: string;
  run(ctx: MigrationContext): Promise<void>;
}

export interface ReportEntry {
  item: string;
  detail: string;
}

export interface MigrationReport {
  counts: Record<string, number>;
  pendingCount: number;
  refusalCount: number;
  conflictCount: number;
  /** The first entries of each kind (capped; the counts are exact). */
  pending: ReportEntry[];
  refusals: ReportEntry[];
  conflicts: ReportEntry[];
}

/** Thrown for a configuration or invocation mistake; the runner exits 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Thrown when this runner no longer holds the claim on a migration. */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
}
