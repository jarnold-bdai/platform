import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { DynamoDbMigrationHistory, InMemoryMigrationHistory, isStale, type ClaimRequest, type HistoryRecord } from './history.js';
import { LeaseLostError, type MigrationReport } from './types.js';

const T0 = new Date('2026-11-21T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const LEASE = 60_000;
const claimBy = (runnerId: string, now = T0): ClaimRequest => ({
  migrationId: '20261121-0930-a', phase: 'pre', description: 'a', runnerId, now, leaseMs: LEASE,
});
const summary: MigrationReport = {
  counts: { scanned: 1 }, pendingCount: 0, refusalCount: 0, conflictCount: 0, pending: [], refusals: [], conflicts: [],
};

describe('InMemoryMigrationHistory', () => {
  it('lets one runner claim a migration and refuses a second while the lease is live', async () => {
    const history = new InMemoryMigrationHistory();
    const first = await history.claim(claimBy('r1'));
    expect(first.claimed).toBe(true);
    const second = await history.claim(claimBy('r2', later(LEASE - 1)));
    expect(second).toMatchObject({ claimed: false, current: { status: 'running', runnerId: 'r1' } });
  });

  it('lets another runner take over a stale running claim, keeping its checkpoint', async () => {
    const history = new InMemoryMigrationHistory();
    await history.claim(claimBy('r1'));
    await history.saveCheckpoint('20261121-0930-a', 'r1', { slot: { startKey: { pk: { S: 'k5' } } } }, T0, LEASE);
    const record = (await history.get('20261121-0930-a'))!;
    expect(isStale(record, later(LEASE - 1))).toBe(false);
    expect(isStale(record, later(LEASE + 1))).toBe(true);

    const takeover = await history.claim(claimBy('r2', later(LEASE + 1)));
    expect(takeover).toMatchObject({
      claimed: true,
      record: { runnerId: 'r2', attempts: 2, checkpoint: { slot: { startKey: { pk: { S: 'k5' } } } } },
    });
    // The crashed runner, if it wakes up, can no longer write.
    expect(await history.heartbeat('20261121-0930-a', 'r1', later(LEASE + 2), LEASE)).toBe(false);
    await expect(history.saveCheckpoint('20261121-0930-a', 'r1', {}, later(LEASE + 2), LEASE)).rejects.toThrow(LeaseLostError);
    await expect(history.finish('20261121-0930-a', 'r1', { status: 'applied', now: later(LEASE + 2), summary }))
      .rejects.toThrow(LeaseLostError);
  });

  it('heartbeats extend the lease', async () => {
    const history = new InMemoryMigrationHistory();
    await history.claim(claimBy('r1'));
    expect(await history.heartbeat('20261121-0930-a', 'r1', later(LEASE - 10), LEASE)).toBe(true);
    expect((await history.claim(claimBy('r2', later(LEASE + 1)))).claimed).toBe(false);
  });

  it('never lets a renewal shorten the lease (a late-arriving older heartbeat or checkpoint is refused)', async () => {
    const history = new InMemoryMigrationHistory();
    await history.claim(claimBy('r1'));
    expect(await history.heartbeat('20261121-0930-a', 'r1', later(20), LEASE)).toBe(true);
    expect(await history.heartbeat('20261121-0930-a', 'r1', later(10), LEASE)).toBe(false);
    await expect(history.saveCheckpoint('20261121-0930-a', 'r1', { s: 1 }, later(10), LEASE)).rejects.toThrow(LeaseLostError);
    expect(await history.get('20261121-0930-a')).toMatchObject({ leaseExpiresAt: later(20 + LEASE).toISOString() });
    expect((await history.get('20261121-0930-a'))?.checkpoint).toBeUndefined();
    expect(await history.heartbeat('20261121-0930-a', 'r1', later(20), LEASE)).toBe(true);
  });

  it('re-claims a failed migration but never an applied one; applied drops the checkpoint', async () => {
    const history = new InMemoryMigrationHistory();
    await history.claim(claimBy('r1'));
    await history.saveCheckpoint('20261121-0930-a', 'r1', { s: 1 }, T0, LEASE);
    await history.finish('20261121-0930-a', 'r1', { status: 'failed', now: later(5), summary, error: 'boom' });
    expect(await history.get('20261121-0930-a')).toMatchObject({ status: 'failed', error: 'boom', checkpoint: { s: 1 } });

    const retry = await history.claim(claimBy('r2', later(10)));
    expect(retry.claimed).toBe(true);
    expect(retry.claimed && retry.record.error).toBeUndefined();
    await history.finish('20261121-0930-a', 'r2', { status: 'applied', now: later(20), summary });
    const applied = (await history.get('20261121-0930-a'))!;
    expect(applied).toMatchObject({ status: 'applied', attempts: 2, finishedAt: later(20).toISOString() });
    expect(applied.checkpoint).toBeUndefined();
    expect(applied.leaseExpiresAt).toBeUndefined();
    expect((await history.claim(claimBy('r3', later(10 * LEASE)))).claimed).toBe(false);
  });
});

/** Every `#name` / `:value` in the expressions is defined, and every defined one is used. */
function expectPlaceholdersMatch(input: UpdateItemCommandInput): void {
  const text = `${input.UpdateExpression ?? ''} ${input.ConditionExpression ?? ''}`;
  const usedNames = new Set(text.match(/#\w+/g));
  const usedValues = new Set(text.match(/:\w+/g));
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(usedNames);
  expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(usedValues);
  // No bare attribute names: every identifier that is not a function or keyword is a placeholder.
  const bare = text.replace(/[#:]\w+/g, '').match(/\b[a-zA-Z_]\w*\b/g) ?? [];
  const allowed = new Set(['SET', 'REMOVE', 'AND', 'OR', 'NOT', 'attribute_exists', 'attribute_not_exists', 'if_not_exists']);
  expect(bare.filter((word) => !allowed.has(word))).toEqual([]);
}

const ccf = () => new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });

describe('DynamoDbMigrationHistory', () => {
  const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
  const ddb = mockClient(client);
  const history = new DynamoDbMigrationHistory({ dynamo: client, tableName: 'History' });

  beforeEach(() => ddb.reset());

  it('claims with one conditional update that also allows a failed or stale record', async () => {
    const stored: HistoryRecord = {
      migrationId: '20261121-0930-a', status: 'running', phase: 'pre', description: 'a', startedAt: T0.toISOString(),
      leaseExpiresAt: later(LEASE).toISOString(), runnerId: 'r1', attempts: 1,
    };
    ddb.on(UpdateItemCommand).resolves({ Attributes: marshall(stored) });
    const result = await history.claim(claimBy('r1'));
    expect(result).toEqual({ claimed: true, record: stored });

    const input = ddb.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(input.TableName).toBe('History');
    expect(input.Key).toEqual({ migrationId: { S: '20261121-0930-a' } });
    expect(input.ConditionExpression).toBe('attribute_not_exists(#migrationId) OR #status = :failed '
      + 'OR (#status = :running AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt < :now))');
    expect(input.ExpressionAttributeValues?.[':leaseExpiresAt']).toEqual({ S: later(LEASE).toISOString() });
    expectPlaceholdersMatch(input);
  });

  it('reports a refused claim with the current record instead of throwing', async () => {
    const holder = { migrationId: '20261121-0930-a', status: 'running', phase: 'pre', description: 'a',
      startedAt: T0.toISOString(), runnerId: 'r1', attempts: 1, leaseExpiresAt: later(LEASE).toISOString() };
    ddb.on(UpdateItemCommand).rejects(ccf());
    ddb.on(GetItemCommand).resolves({ Item: marshall(holder) });
    expect(await history.claim(claimBy('r2'))).toEqual({ claimed: false, current: holder });
    expect(ddb.commandCalls(GetItemCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  it('lets other AWS errors through', async () => {
    ddb.on(UpdateItemCommand).rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException', $metadata: {} }));
    await expect(history.claim(claimBy('r1'))).rejects.toThrow('throttled');
  });

  it('conditions heartbeat, checkpoint and finish on holding the claim', async () => {
    ddb.on(UpdateItemCommand).resolves({});
    expect(await history.heartbeat('20261121-0930-a', 'r1', T0, LEASE)).toBe(true);
    await history.saveCheckpoint('20261121-0930-a', 'r1', { scan: { startKey: { pk: { B: new Uint8Array([1, 2]) } } } }, T0, LEASE);
    await history.finish('20261121-0930-a', 'r1', { status: 'failed', now: T0, summary, error: 'boom' });
    await history.finish('20261121-0930-a', 'r1', { status: 'applied', now: T0, summary });
    const inputs = ddb.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
    const held = '#runnerId = :runnerId AND #status = :running';
    const renewable = `${held} AND (attribute_not_exists(#leaseExpiresAt) OR #leaseExpiresAt <= :leaseExpiresAt)`;
    expect(inputs.map((input) => input.ConditionExpression)).toEqual([renewable, renewable, held, held]);
    for (const input of inputs) {
      expect(input.ExpressionAttributeValues?.[':runnerId']).toEqual({ S: 'r1' });
      expectPlaceholdersMatch(input);
    }
    expect(inputs[2]!.UpdateExpression).toContain('#error = :error');
    expect(inputs[2]!.UpdateExpression).not.toContain('#checkpoint');
    expect(inputs[3]!.UpdateExpression).toContain('REMOVE #leaseExpiresAt, #checkpoint');

    ddb.reset();
    ddb.on(UpdateItemCommand).rejects(ccf());
    expect(await history.heartbeat('20261121-0930-a', 'r1', T0, LEASE)).toBe(false);
    await expect(history.saveCheckpoint('20261121-0930-a', 'r1', {}, T0, LEASE)).rejects.toThrow(LeaseLostError);
    await expect(history.finish('20261121-0930-a', 'r1', { status: 'applied', now: T0, summary })).rejects.toThrow(LeaseLostError);
  });

  it('sends max(now, the previous time sent), so a clock stepping backwards does not look like a lost claim', async () => {
    ddb.on(UpdateItemCommand).resolves({});
    await history.heartbeat('20261121-0930-a', 'r1', later(1000), LEASE);
    await history.heartbeat('20261121-0930-a', 'r1', later(500), LEASE);
    await history.saveCheckpoint('20261121-0930-a', 'r1', {}, later(200), LEASE);
    const [, beat, save] = ddb.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
    for (const input of [beat!, save!]) {
      expect(input.ExpressionAttributeValues?.[':leaseExpiresAt']).toEqual({ S: later(1000 + LEASE).toISOString() });
    }
  });

  it('passes an abort signal to the heartbeat and checkpoint requests', async () => {
    ddb.on(UpdateItemCommand).resolves({});
    const signal = new AbortController().signal;
    await history.heartbeat('20261121-0930-a', 'r1', T0, LEASE, signal);
    await history.saveCheckpoint('20261121-0930-a', 'r1', {}, T0, LEASE, signal);
    for (const call of ddb.commandCalls(UpdateItemCommand)) expect((call.args as unknown[])[1]).toMatchObject({ abortSignal: signal });
  });

  it('round-trips a checkpoint holding a binary scan key', async () => {
    ddb.on(UpdateItemCommand).resolves({});
    const checkpoint = { scan: { startKey: { pk: { B: new Uint8Array([1, 2]) }, sk: { N: '7' } } } };
    await history.saveCheckpoint('20261121-0930-a', 'r1', checkpoint, T0, LEASE);
    const stored = ddb.commandCalls(UpdateItemCommand)[0]!.args[0].input.ExpressionAttributeValues![':checkpoint']!;
    ddb.on(GetItemCommand).resolves({
      Item: { migrationId: { S: '20261121-0930-a' }, status: { S: 'failed' }, attempts: { N: '1' }, checkpoint: stored },
    });
    const record = await history.get('20261121-0930-a');
    expect(record?.checkpoint).toEqual(checkpoint);
    expect(record?.attempts).toBe(1);
  });

  it('lists every page of the history table', async () => {
    const rec = (id: string) => marshall({ migrationId: id, status: 'applied', phase: 'pre', description: id, startedAt: 'x', attempts: 1 });
    ddb.on(ScanCommand)
      .resolvesOnce({ Items: [rec('a')], LastEvaluatedKey: { migrationId: { S: 'a' } } })
      .resolvesOnce({ Items: [rec('b')] });
    expect((await history.list()).map((r) => r.migrationId)).toEqual(['a', 'b']);
    expect(ddb.commandCalls(ScanCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ migrationId: { S: 'a' } });
  });
});
