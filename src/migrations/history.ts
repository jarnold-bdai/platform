import {
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { convertToAttr, unmarshall } from '@aws-sdk/util-dynamodb';
import { LeaseLostError, isLeaseLostError, type Item, type MigrationReport, type Phase } from './types.js';

export type HistoryStatus = 'running' | 'applied' | 'failed';

/**
 * One item per migration in the history table (hash key `migrationId`, S).
 * Times are ISO-8601 UTC strings, so they compare lexically.
 */
export interface HistoryRecord {
  migrationId: string;
  status: HistoryStatus;
  phase: Phase;
  description: string;
  /** When the current (or last) attempt started. */
  startedAt: string;
  /** When the last attempt ended (absent while `running`). */
  finishedAt?: string;
  /** Last time the claim's holder renewed it. */
  heartbeatAt?: string;
  /** A `running` claim whose lease is past may be taken over by another runner. Absent once finished. */
  leaseExpiresAt?: string;
  /** Random id of the runner holding (or that last held) the claim. */
  runnerId?: string;
  /** How many times the migration has been claimed. */
  attempts: number;
  /** Checkpoint slots (see `CheckpointStore`); kept on failure so a re-run resumes, removed once applied. */
  checkpoint?: Record<string, unknown>;
  /** The report of the last attempt, with capped entry lists. */
  summary?: MigrationReport;
  /** Why the last attempt failed. */
  error?: string;
}

export interface ClaimRequest {
  migrationId: string;
  phase: Phase;
  description: string;
  runnerId: string;
  now: Date;
  leaseMs: number;
}

export type ClaimResult =
  | { claimed: true; record: HistoryRecord }
  /** Someone else holds a live claim, or the migration is already applied. */
  | { claimed: false; current: HistoryRecord | undefined };

export interface FinishRequest {
  status: 'applied' | 'failed';
  now: Date;
  summary: MigrationReport;
  error?: string;
}

/**
 * Where the runner records what was applied. A claim succeeds only when the
 * migration has no record, its last attempt failed, or it is `running` with an
 * expired lease (a crashed runner). Every later write is conditional on the
 * caller still holding the claim.
 */
export interface MigrationHistory {
  list(): Promise<HistoryRecord[]>;
  get(migrationId: string): Promise<HistoryRecord | undefined>;
  claim(request: ClaimRequest): Promise<ClaimResult>;
  /**
   * Renews the lease to `now + leaseMs`; false when the caller no longer holds
   * the claim. A renewal never shortens the stored lease: one that arrives
   * after a later renewal (e.g. an abandoned request that still reached the
   * table) is refused. `signal` aborts the request.
   */
  heartbeat(migrationId: string, runnerId: string, now: Date, leaseMs: number, signal?: AbortSignal): Promise<boolean>;
  /**
   * Stores the checkpoint and renews the lease like `heartbeat`; throws
   * `LeaseLostError` when the caller no longer holds the claim.
   */
  saveCheckpoint(
    migrationId: string, runnerId: string, checkpoint: Record<string, unknown>, now: Date, leaseMs: number, signal?: AbortSignal,
  ): Promise<void>;
  /** Ends the attempt; throws `LeaseLostError` when the caller no longer holds the claim. */
  finish(migrationId: string, runnerId: string, request: FinishRequest): Promise<void>;
}

const leaseEnd = (now: Date, leaseMs: number): string => new Date(now.getTime() + leaseMs).toISOString();

/** True for a `running` record whose lease has expired at `now`. */
export function isStale(record: HistoryRecord, now: Date): boolean {
  return record.status === 'running' && (record.leaseExpiresAt === undefined || record.leaseExpiresAt < now.toISOString());
}

function claimable(record: HistoryRecord | undefined, now: Date): boolean {
  return record === undefined || record.status === 'failed' || isStale(record, now);
}

/** For tests and local experiments: the same rules as the DynamoDB history, in memory. */
export class InMemoryMigrationHistory implements MigrationHistory {
  private readonly records = new Map<string, HistoryRecord>();

  constructor(initial: readonly HistoryRecord[] = []) {
    for (const record of initial) this.records.set(record.migrationId, structuredClone(record));
  }

  async list(): Promise<HistoryRecord[]> {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  async get(migrationId: string): Promise<HistoryRecord | undefined> {
    const record = this.records.get(migrationId);
    return record && structuredClone(record);
  }

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const current = this.records.get(request.migrationId);
    if (!claimable(current, request.now)) return { claimed: false, current: current && structuredClone(current) };
    const now = request.now.toISOString();
    const record: HistoryRecord = {
      ...current,
      migrationId: request.migrationId,
      status: 'running',
      phase: request.phase,
      description: request.description,
      startedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: leaseEnd(request.now, request.leaseMs),
      runnerId: request.runnerId,
      attempts: (current?.attempts ?? 0) + 1,
    };
    delete record.finishedAt;
    delete record.error;
    this.records.set(request.migrationId, record);
    return { claimed: true, record: structuredClone(record) };
  }

  private held(migrationId: string, runnerId: string): HistoryRecord | undefined {
    const record = this.records.get(migrationId);
    return record?.status === 'running' && record.runnerId === runnerId ? record : undefined;
  }

  /** Held, and the renewal would not shorten the stored lease. */
  private renewable(migrationId: string, runnerId: string, now: Date, leaseMs: number): HistoryRecord | undefined {
    const record = this.held(migrationId, runnerId);
    if (!record) return undefined;
    return record.leaseExpiresAt === undefined || record.leaseExpiresAt <= leaseEnd(now, leaseMs) ? record : undefined;
  }

  // In memory nothing can hang, so `signal` is accepted and ignored.
  async heartbeat(migrationId: string, runnerId: string, now: Date, leaseMs: number, _signal?: AbortSignal): Promise<boolean> {
    const record = this.renewable(migrationId, runnerId, now, leaseMs);
    if (!record) return false;
    record.heartbeatAt = now.toISOString();
    record.leaseExpiresAt = leaseEnd(now, leaseMs);
    return true;
  }

  async saveCheckpoint(
    migrationId: string, runnerId: string, checkpoint: Record<string, unknown>, now: Date, leaseMs: number, _signal?: AbortSignal,
  ): Promise<void> {
    const record = this.renewable(migrationId, runnerId, now, leaseMs);
    if (!record) throw new LeaseLostError(`${migrationId}: this runner no longer holds the claim`);
    record.checkpoint = structuredClone(checkpoint);
    record.heartbeatAt = now.toISOString();
    record.leaseExpiresAt = leaseEnd(now, leaseMs);
  }

  async finish(migrationId: string, runnerId: string, request: FinishRequest): Promise<void> {
    const record = this.held(migrationId, runnerId);
    if (!record) throw new LeaseLostError(`${migrationId}: this runner no longer holds the claim`);
    record.status = request.status;
    record.finishedAt = request.now.toISOString();
    record.summary = structuredClone(request.summary);
    delete record.leaseExpiresAt;
    if (request.error !== undefined) record.error = request.error;
    if (request.status === 'applied') delete record.checkpoint;
  }
}

export interface DynamoDbMigrationHistoryOptions {
  dynamo: DynamoDBClient;
  /** The real name of the history table: hash key `migrationId` (S), no sort key. */
  tableName: string;
}

const isConditionalCheckFailed = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';

const attr = (value: unknown): AttributeValue => convertToAttr(value, { removeUndefinedValues: true });

/** The `#name` placeholder for every attribute the history writes or tests. */
const NAMES = {
  '#migrationId': 'migrationId',
  '#status': 'status',
  '#phase': 'phase',
  '#description': 'description',
  '#startedAt': 'startedAt',
  '#finishedAt': 'finishedAt',
  '#heartbeatAt': 'heartbeatAt',
  '#leaseExpiresAt': 'leaseExpiresAt',
  '#runnerId': 'runnerId',
  '#attempts': 'attempts',
  '#checkpoint': 'checkpoint',
  '#summary': 'summary',
  '#error': 'error',
} as const;
type Placeholder = keyof typeof NAMES;

/** Only the placeholders an expression uses (DynamoDB rejects unused ones). */
function namesFor(...expressions: string[]): Record<string, string> {
  const text = expressions.join(' ');
  return Object.fromEntries(
    (Object.keys(NAMES) as Placeholder[]).filter((p) => new RegExp(`${p}\\b`).test(text)).map((p) => [p, NAMES[p]]),
  );
}

const HELD = '#runnerId = :runnerId AND #status = :running';
/** Held, and the new lease is not earlier than the stored one, so a late-arriving renewal cannot shorten it. */
const RENEWABLE = `${HELD} AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt <= :leaseExpiresAt)`;

/** The history in one DynamoDB table that the consumer names and creates. */
export class DynamoDbMigrationHistory implements MigrationHistory {
  private readonly dynamo: DynamoDBClient;
  private readonly tableName: string;

  constructor(options: DynamoDbMigrationHistoryOptions) {
    this.dynamo = options.dynamo;
    this.tableName = options.tableName;
  }

  async list(): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = [];
    let startKey: Item | undefined;
    do {
      const page = await this.dynamo.send(new ScanCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }));
      for (const item of page.Items ?? []) records.push(toRecord(item));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return records;
  }

  async get(migrationId: string): Promise<HistoryRecord | undefined> {
    const result = await this.dynamo.send(new GetItemCommand({
      TableName: this.tableName,
      Key: { migrationId: { S: migrationId } },
      ConsistentRead: true,
    }));
    return result.Item ? toRecord(result.Item) : undefined;
  }

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    const now = request.now.toISOString();
    const update = 'SET #status = :running, #phase = :phase, #description = :description, #startedAt = :now, '
      + '#heartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt, #runnerId = :runnerId, '
      + '#attempts = if_not_exists(#attempts, :zero) + :one REMOVE #finishedAt, #error';
    const condition = 'attribute_not_exists(#migrationId) OR #status = :failed '
      + 'OR (#status = :running AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt < :now))';
    try {
      const result = await this.dynamo.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: { migrationId: { S: request.migrationId } },
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: namesFor(update, condition),
        ExpressionAttributeValues: {
          ':running': { S: 'running' },
          ':failed': { S: 'failed' },
          ':phase': { S: request.phase },
          ':description': { S: request.description },
          ':now': { S: now },
          ':leaseExpiresAt': { S: leaseEnd(request.now, request.leaseMs) },
          ':runnerId': { S: request.runnerId },
          ':zero': { N: '0' },
          ':one': { N: '1' },
        },
        ReturnValues: 'ALL_NEW',
      }));
      if (!result.Attributes) throw new Error(`claim of ${request.migrationId} returned no attributes`);
      return { claimed: true, record: toRecord(result.Attributes) };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      return { claimed: false, current: await this.get(request.migrationId) };
    }
  }

  async heartbeat(migrationId: string, runnerId: string, now: Date, leaseMs: number, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.updateHeld(migrationId, runnerId, 'SET #heartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt', {
        ':now': { S: now.toISOString() },
        ':leaseExpiresAt': { S: leaseEnd(now, leaseMs) },
      }, RENEWABLE, signal);
      return true;
    } catch (error) {
      if (isLeaseLostError(error)) return false;
      throw error;
    }
  }

  async saveCheckpoint(
    migrationId: string, runnerId: string, checkpoint: Record<string, unknown>, now: Date, leaseMs: number, signal?: AbortSignal,
  ): Promise<void> {
    await this.updateHeld(migrationId, runnerId,
      'SET #checkpoint = :checkpoint, #heartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt', {
        ':checkpoint': attr(checkpoint),
        ':now': { S: now.toISOString() },
        ':leaseExpiresAt': { S: leaseEnd(now, leaseMs) },
      }, RENEWABLE, signal);
  }

  async finish(migrationId: string, runnerId: string, request: FinishRequest): Promise<void> {
    const sets = ['#status = :status', '#finishedAt = :now', '#summary = :summary'];
    const removes = ['#leaseExpiresAt'];
    const values: Record<string, AttributeValue> = {
      ':status': { S: request.status },
      ':now': { S: request.now.toISOString() },
      ':summary': attr(request.summary),
    };
    if (request.error !== undefined) {
      sets.push('#error = :error');
      values[':error'] = { S: request.error };
    }
    if (request.status === 'applied') removes.push('#checkpoint');
    await this.updateHeld(migrationId, runnerId, `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`, values);
  }

  /** An update conditional on `runnerId` still holding the `running` claim (`HELD`, or the stricter `RENEWABLE`). */
  private async updateHeld(
    migrationId: string,
    runnerId: string,
    update: string,
    values: Record<string, AttributeValue>,
    condition: string = HELD,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const command = new UpdateItemCommand({
        TableName: this.tableName,
        Key: { migrationId: { S: migrationId } },
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: namesFor(update, condition),
        ExpressionAttributeValues: { ...values, ':runnerId': { S: runnerId }, ':running': { S: 'running' } },
      });
      await (signal ? this.dynamo.send(command, { abortSignal: signal }) : this.dynamo.send(command));
    } catch (error) {
      if (isConditionalCheckFailed(error)) throw new LeaseLostError(`${migrationId}: this runner no longer holds the claim`);
      throw error;
    }
  }
}

function toRecord(item: Item): HistoryRecord {
  const raw = unmarshall(item) as Record<string, unknown>;
  return { ...raw, attempts: Number(raw.attempts ?? 0) } as HistoryRecord;
}
