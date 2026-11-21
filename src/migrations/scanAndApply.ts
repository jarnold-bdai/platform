import {
  DeleteItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import type { Item, MigrationContext } from './types.js';

/** A condition expression with its `#name` / `:value` placeholders. */
export interface Condition {
  expression: string;
  names?: Record<string, string>;
  values?: Record<string, AttributeValue>;
}

/** A write. The condition is required: it must fail if the item changed since it was scanned. */
export type WriteOp =
  | { kind: 'put'; item: Item; condition: Condition }
  | {
    kind: 'update';
    key: Item;
    updateExpression: string;
    names?: Record<string, string>;
    values?: Record<string, AttributeValue>;
    condition: Condition;
  }
  | { kind: 'delete'; key: Item; condition: Condition };

export type PlanResult =
  /** Already in the target state. */
  | { action: 'skip' }
  /** Needs this write. `detail` is shown in logs and reports. */
  | { action: 'write'; write: WriteOp; detail?: string }
  /** Never written; stops the run until resolved. */
  | { action: 'refuse'; reason: string };

/**
 * Pure: what to do with one scanned item. It must not do IO, and it must
 * return `skip` for an item it has already written, so a re-run is safe.
 */
export type PlanFn = (item: Item) => PlanResult;

export interface ScanAndApplyOptions {
  /** The logical table name, resolved with `ctx.tableName`. */
  table: string;
  /** The table's key attribute names (hash, then range), used to label items in logs and reports. */
  key: readonly string[];
  plan: PlanFn;
  /** Items per Scan page; the checkpoint is saved after each page. Default 100. */
  pageSize?: number;
  /** Checkpoint slot; default `scan:<table>`. Give each scan of the same table in one migration its own. */
  checkpointSlot?: string;
  /** An optional Scan filter (use `#name` placeholders). Filtered-out items are not planned. */
  filter?: Condition;
}

export interface ScanSummary {
  scanned: number;
  skipped: number;
  written: number;
  pending: number;
  refused: number;
  conflicts: number;
  /** True when this scan started from a checkpoint left by an earlier attempt. */
  resumed: boolean;
  /** True when an earlier attempt had already finished this scan, so it was not repeated. */
  alreadyDone: boolean;
}

/** What the scan keeps in its checkpoint slot. */
export interface ScanCheckpoint {
  /** Resume here (the Scan's `ExclusiveStartKey`). */
  startKey?: Item;
  /** Every item was resolved in an earlier attempt. */
  done?: boolean;
}

export const DEFAULT_PAGE_SIZE = 100;

/** `pk=CONFIG#1,sk=DRAFT` from the key attributes. */
export function itemLabel(item: Item, key: readonly string[]): string {
  return key.map((name) => `${name}=${attributeText(item[name])}`).join(',');
}

function attributeText(value: AttributeValue | undefined): string {
  if (value === undefined) return '<absent>';
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return value.N;
  if (value.B !== undefined) return Buffer.from(value.B).toString('base64');
  return JSON.stringify(value);
}

/**
 * Condition: each listed attribute still holds the value scanned, or is still
 * absent. Include the key attribute to also require that the item exists.
 */
export function unchangedCondition(before: Item, attributes: readonly string[]): Condition {
  const parts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  attributes.forEach((name, i) => {
    names[`#unchanged${i}`] = name;
    const value = before[name];
    if (value === undefined) {
      parts.push(`attribute_not_exists(#unchanged${i})`);
    } else {
      values[`:unchanged${i}`] = value;
      parts.push(`#unchanged${i} = :unchanged${i}`);
    }
  });
  if (parts.length === 0) throw new Error('unchangedCondition needs at least one attribute');
  return { expression: parts.join(' AND '), names, ...(Object.keys(values).length > 0 ? { values } : {}) };
}

/** Condition: the attribute is absent (for a put that creates an item: pass its hash key). */
export function absentCondition(attribute: string): Condition {
  return { expression: 'attribute_not_exists(#absent)', names: { '#absent': attribute } };
}

function merge<T>(kind: string, a: Record<string, T> | undefined, b: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, T> = { ...a };
  for (const [placeholder, value] of Object.entries(b ?? {})) {
    if (placeholder in out && JSON.stringify(out[placeholder]) !== JSON.stringify(value)) {
      throw new Error(`${kind} placeholder ${placeholder} is used with two different values`);
    }
    out[placeholder] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const isConditionalCheckFailed = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';

async function applyWrite(ctx: MigrationContext, tableName: string, write: WriteOp): Promise<'written' | 'conflict'> {
  const { condition } = write;
  if (!condition || typeof condition.expression !== 'string' || condition.expression.trim() === '') {
    throw new Error('a planned write needs a condition expression');
  }
  let send: () => Promise<unknown>;
  if (write.kind === 'put') {
    const command = new PutItemCommand({
      TableName: tableName,
      Item: write.item,
      ConditionExpression: condition.expression,
      ExpressionAttributeNames: condition.names,
      ExpressionAttributeValues: condition.values,
    });
    send = () => ctx.dynamo.send(command);
  } else if (write.kind === 'update') {
    const command = new UpdateItemCommand({
      TableName: tableName,
      Key: write.key,
      UpdateExpression: write.updateExpression,
      ConditionExpression: condition.expression,
      ExpressionAttributeNames: merge('name', write.names, condition.names),
      ExpressionAttributeValues: merge('value', write.values, condition.values),
    });
    send = () => ctx.dynamo.send(command);
  } else if (write.kind === 'delete') {
    const command = new DeleteItemCommand({
      TableName: tableName,
      Key: write.key,
      ConditionExpression: condition.expression,
      ExpressionAttributeNames: condition.names,
      ExpressionAttributeValues: condition.values,
    });
    send = () => ctx.dynamo.send(command);
  } else {
    throw new Error(`unknown write kind ${JSON.stringify((write as { kind?: unknown }).kind)}`);
  }
  try {
    await send();
    return 'written';
  } catch (error) {
    if (isConditionalCheckFailed(error)) return 'conflict';
    throw error;
  }
}

/**
 * Scans one table page by page and calls `plan` for each item.
 *
 * - `dry-run`: logs and counts what would be written or refused; writes nothing.
 * - `check`: the same; any item that would be written or refused fails the check.
 * - `write`: performs each planned write with its condition. A failed
 *   condition is reported as a conflict (the run then stops, nothing crashes).
 *   After each page the checkpoint is saved, so a re-run resumes from there;
 *   once an item on a page is refused or conflicts, the checkpoint stops
 *   advancing, so the re-run after the fix sees that item again.
 */
export async function scanAndApply(ctx: MigrationContext, options: ScanAndApplyOptions): Promise<ScanSummary> {
  const tableName = ctx.tableName(options.table);
  const slot = options.checkpointSlot ?? `scan:${options.table}`;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer');
  const summary: ScanSummary = {
    scanned: 0, skipped: 0, written: 0, pending: 0, refused: 0, conflicts: 0, resumed: false, alreadyDone: false,
  };

  const saved = await ctx.checkpoint.load<ScanCheckpoint>(slot);
  if (saved?.done) {
    ctx.log.info(`${options.table}: already scanned to the end in an earlier attempt; not repeated`);
    summary.alreadyDone = true;
    return summary;
  }
  let startKey = saved?.startKey;
  if (startKey) {
    summary.resumed = true;
    ctx.log.info(`${options.table}: resuming after ${itemLabel(startKey, options.key)}`);
  }

  // Once false, later pages are still processed and reported, but the
  // checkpoint stays before the first unresolved item.
  let advance = true;
  do {
    ctx.signal.throwIfAborted();
    const page = await ctx.dynamo.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      Limit: pageSize,
      ExclusiveStartKey: startKey,
      ...(options.filter
        ? {
          FilterExpression: options.filter.expression,
          ExpressionAttributeNames: options.filter.names,
          ExpressionAttributeValues: options.filter.values,
        }
        : {}),
    }));
    for (const item of page.Items ?? []) {
      ctx.signal.throwIfAborted();
      summary.scanned += 1;
      ctx.report.count('scanned');
      const label = itemLabel(item, options.key);
      let result: PlanResult;
      try {
        result = options.plan(item);
      } catch (error) {
        throw new Error(`plan threw for ${options.table} ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (result.action === 'skip') {
        summary.skipped += 1;
        ctx.report.count('skipped');
      } else if (result.action === 'refuse') {
        summary.refused += 1;
        advance = false;
        ctx.report.refuse(`${options.table} ${label}`, result.reason);
        ctx.log.warn(`REFUSED ${options.table} ${label}: ${result.reason}`);
      } else if (result.action === 'write') {
        const detail = result.detail ?? result.write.kind;
        if (ctx.mode !== 'write') {
          summary.pending += 1;
          ctx.report.pending(`${options.table} ${label}`, detail);
          ctx.log.info(`would write ${options.table} ${label}: ${detail}`);
        } else if (await applyWrite(ctx, tableName, result.write) === 'written') {
          summary.written += 1;
          ctx.report.count('written');
          ctx.log.info(`wrote ${options.table} ${label}: ${detail}`);
        } else {
          summary.conflicts += 1;
          advance = false;
          ctx.report.conflict(`${options.table} ${label}`, 'condition failed: the item changed since it was scanned; re-run to re-plan it');
          ctx.log.warn(`CONFLICT ${options.table} ${label}: changed since the scan (re-run to re-plan it)`);
        }
      } else {
        throw new Error(`plan returned an unknown action for ${options.table} ${label}`);
      }
    }
    startKey = page.LastEvaluatedKey;
    if (advance) await ctx.checkpoint.save(slot, startKey ? { startKey } : { done: true });
  } while (startKey);

  ctx.log.info(`${options.table}: scanned=${summary.scanned} skipped=${summary.skipped} written=${summary.written} `
    + `pending=${summary.pending} refused=${summary.refused} conflicts=${summary.conflicts}`);
  return summary;
}
