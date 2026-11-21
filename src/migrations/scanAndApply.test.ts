import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
  type PutItemCommandInput,
  type ScanCommandInput,
} from '@aws-sdk/client-dynamodb';
import { InMemoryMigrationHistory } from './history.js';
import { runMigrations, type RunOptions } from './runner.js';
import { absentCondition, scanAndApply, unchangedCondition, type PlanResult, type ScanSummary } from './scanAndApply.js';
import type { Item, Logger, Migration, Mode } from './types.js';

const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
const ddb = mockClient(client);
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const ID = '20261121-0930-set-format';

/** A fake table keyed by `pk` (S), scanned in key order, `Limit` items per page. */
class FakeTable {
  readonly items = new Map<string, Item>();
  /** Keys whose next write fails its condition (a concurrent change). */
  readonly conflictKeys = new Set<string>();
  /** Throw this on the n-th Scan call (1-based), once. */
  failScanAt?: { call: number; error: Error };
  scans: ScanCommandInput[] = [];

  constructor(count: number, shape: (i: number) => Item = () => ({})) {
    for (let i = 0; i < count; i += 1) {
      const pk = `k${String(i).padStart(2, '0')}`;
      this.items.set(pk, { pk: { S: pk }, ...shape(i) });
    }
  }

  install(): void {
    ddb.reset();
    ddb.on(ScanCommand).callsFake((input: ScanCommandInput) => {
      this.scans.push(input);
      if (this.failScanAt?.call === this.scans.length) {
        const { error } = this.failScanAt;
        this.failScanAt = undefined;
        throw error;
      }
      const after = input.ExclusiveStartKey?.pk?.S;
      const keys = [...this.items.keys()].sort().filter((k) => after === undefined || k > after);
      const page = keys.slice(0, input.Limit ?? keys.length);
      const more = keys.length > page.length;
      return { Items: page.map((k) => this.items.get(k)), ...(more ? { LastEvaluatedKey: { pk: { S: page.at(-1)! } } } : {}) };
    });
    ddb.on(PutItemCommand).callsFake((input: PutItemCommandInput) => {
      const pk = input.Item!.pk!.S!;
      if (this.conflictKeys.has(pk)) {
        throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
      }
      this.items.set(pk, input.Item!);
      return {};
    });
  }

  formatOf(pk: string): string | undefined {
    return this.items.get(pk)?.configFormat?.S;
  }
}

/** Pure plan: give every item `configFormat: legacy`; refuse items flagged `bad`. */
const plan = (item: Item): PlanResult => {
  if (item.configFormat?.S === 'legacy') return { action: 'skip' };
  if (item.bad) return { action: 'refuse', reason: 'bad item' };
  return {
    action: 'write',
    detail: 'configFormat=legacy',
    write: { kind: 'put', item: { ...item, configFormat: { S: 'legacy' } }, condition: unchangedCondition(item, ['pk', 'configFormat']) },
  };
};

let summaries: ScanSummary[] = [];
const scanMigration = (extraScan?: (ctx: Parameters<Migration['run']>[0]) => Promise<void>): Migration => ({
  id: ID,
  phase: 'pre',
  description: 'mark every item legacy',
  run: async (ctx) => {
    summaries.push(await scanAndApply(ctx, { table: 'Things', key: ['pk'], plan, pageSize: 3 }));
    await extraScan?.(ctx);
  },
});

const run = (history: InMemoryMigrationHistory, mode: Mode, extra: Partial<RunOptions> = {}) => runMigrations({
  migrations: [scanMigration()], phase: 'pre', mode, dynamo: client, history, logger: silent,
  resolveTable: (name) => (name === 'Things' ? 'Things-dev' : undefined), ...extra,
});

beforeEach(() => {
  summaries = [];
});

describe('scanAndApply', () => {
  it('dry run writes nothing to the data or the history', async () => {
    const table = new FakeTable(7);
    table.install();
    const history = new InMemoryMigrationHistory();
    const result = await run(history, 'dry-run');
    expect(result.exitCode).toBe(1);
    expect(result.migrations[0]).toMatchObject({ status: 'would-apply', report: { pendingCount: 7, counts: { scanned: 7 } } });
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(await history.list()).toEqual([]);
    expect(table.scans.map((s) => s.ExclusiveStartKey?.pk?.S)).toEqual([undefined, 'k02', 'k05']);
    expect(table.scans.every((s) => s.TableName === 'Things-dev' && s.ConsistentRead === true && s.Limit === 3)).toBe(true);
  });

  it('writes with the plan condition, records the migration, and a re-run is a no-op', async () => {
    const table = new FakeTable(7, (i): Item => (i === 2 ? { configFormat: { S: 'legacy' } } : {}));
    table.install();
    const history = new InMemoryMigrationHistory();
    const result = await run(history, 'write');
    expect(result.exitCode).toBe(0);
    expect(summaries[0]).toMatchObject({ scanned: 7, skipped: 1, written: 6, refused: 0, conflicts: 0 });
    expect([...table.items.keys()].every((k) => table.formatOf(k) === 'legacy')).toBe(true);

    const put = ddb.commandCalls(PutItemCommand)[0]!.args[0].input;
    expect(put.ConditionExpression).toBe('#unchanged0 = :unchanged0 AND attribute_not_exists(#unchanged1)');
    expect(put.ExpressionAttributeNames).toEqual({ '#unchanged0': 'pk', '#unchanged1': 'configFormat' });
    expect(put.ExpressionAttributeValues).toEqual({ ':unchanged0': { S: 'k00' } });

    const record = await history.get(ID);
    expect(record).toMatchObject({ status: 'applied', summary: { counts: { scanned: 7, skipped: 1, written: 6 } } });
    expect(record?.checkpoint).toBeUndefined();

    // Already applied: not run again. A check of it (--only) scans and passes.
    expect((await run(history, 'write')).migrations[0]!.status).toBe('already-applied');
    const check = await run(history, 'check', { only: ID });
    expect(check).toMatchObject({ exitCode: 0, migrations: [{ status: 'check-passed' }] });
  });

  it('reports a failed condition as a conflict, keeps going, and resumes before it on the re-run', async () => {
    const table = new FakeTable(9);
    table.conflictKeys.add('k04');
    table.install();
    const history = new InMemoryMigrationHistory();
    const first = await run(history, 'write');
    expect(first.exitCode).toBe(1);
    expect(first.migrations[0]).toMatchObject({
      status: 'conflict',
      report: { conflictCount: 1, conflicts: [{ item: 'Things pk=k04' }] },
    });
    expect(summaries[0]).toMatchObject({ written: 8, conflicts: 1 });
    // The checkpoint stayed after page 1 (k00-k02), before the conflicted item's page.
    expect(await history.get(ID)).toMatchObject({ status: 'failed', checkpoint: { 'scan:Things': { startKey: { pk: { S: 'k02' } } } } });

    table.conflictKeys.clear();
    table.scans = [];
    const second = await run(history, 'write');
    expect(second.exitCode).toBe(0);
    expect(table.scans[0]!.ExclusiveStartKey).toEqual({ pk: { S: 'k02' } });
    expect(summaries[1]).toMatchObject({ resumed: true, scanned: 6, skipped: 5, written: 1 });
    expect(table.formatOf('k04')).toBe('legacy');
  });

  it('resumes from the last checkpoint after a crash mid-scan', async () => {
    const table = new FakeTable(10);
    table.failScanAt = { call: 3, error: new Error('socket hang up') };
    table.install();
    const history = new InMemoryMigrationHistory();
    const first = await run(history, 'write');
    expect(first).toMatchObject({ exitCode: 1, migrations: [{ status: 'failed', message: 'socket hang up' }] });
    expect(await history.get(ID)).toMatchObject({ status: 'failed', checkpoint: { 'scan:Things': { startKey: { pk: { S: 'k05' } } } } });

    table.scans = [];
    const second = await run(history, 'write');
    expect(second.exitCode).toBe(0);
    expect(table.scans.map((s) => s.ExclusiveStartKey?.pk?.S)).toEqual(['k05', 'k08']);
    // The crashed attempt never returned a summary; this is the resumed one.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ resumed: true, scanned: 4, written: 4 });
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(10);
  });

  it('never writes a refused item and does not checkpoint past it', async () => {
    const table = new FakeTable(5, (i): Item => (i === 1 ? { bad: { BOOL: true } } : {}));
    table.install();
    const history = new InMemoryMigrationHistory();
    const result = await run(history, 'write');
    expect(result.migrations[0]).toMatchObject({ status: 'refused', report: { refusals: [{ item: 'Things pk=k01', detail: 'bad item' }] } });
    expect(result.exitCode).toBe(1);
    expect(table.formatOf('k01')).toBeUndefined();
    expect(table.formatOf('k04')).toBe('legacy');
    const record = await history.get(ID);
    expect(record).toMatchObject({ status: 'failed', error: '1 item(s) refused' });
    // The refusal is on the first page, so no checkpoint was ever saved: the re-run starts over.
    expect(record?.checkpoint).toBeUndefined();
  });

  it('check mode fails on items to write or refuse and writes nothing', async () => {
    const table = new FakeTable(4, (i): Item => (i === 0 ? { bad: { BOOL: true } } : i === 1 ? {} : { configFormat: { S: 'legacy' } }));
    table.install();
    const history = new InMemoryMigrationHistory();
    const refused = await run(history, 'check');
    expect(refused).toMatchObject({ exitCode: 1, migrations: [{ status: 'refused', report: { pendingCount: 1, refusalCount: 1 } }] });

    table.items.delete('k00');
    const pending = await run(history, 'check');
    expect(pending).toMatchObject({ exitCode: 1, migrations: [{ status: 'check-failed', message: '1 item(s) to write' }] });
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(await history.list()).toEqual([]);
  });

  it('skips a scan an earlier attempt finished when a later step failed', async () => {
    const table = new FakeTable(4);
    table.install();
    const history = new InMemoryMigrationHistory();
    let failLater = true;
    const m = scanMigration(async () => { if (failLater) throw new Error('second step failed'); });
    const opts = { migrations: [m] };
    expect((await run(history, 'write', opts)).exitCode).toBe(1);
    expect(await history.get(ID)).toMatchObject({ checkpoint: { 'scan:Things': { done: true } } });

    failLater = false;
    table.scans = [];
    expect((await run(history, 'write', opts)).exitCode).toBe(0);
    expect(table.scans).toHaveLength(0);
    expect(summaries[1]).toMatchObject({ alreadyDone: true, scanned: 0 });
  });

  it('sends update and delete writes with merged placeholders, and rejects clashing ones', async () => {
    const table = new FakeTable(2);
    table.install();
    ddb.on(UpdateItemCommand).resolves({}).on(DeleteItemCommand).resolves({});
    const history = new InMemoryMigrationHistory();
    const updatePlan = (item: Item): PlanResult => (item.pk!.S === 'k00'
      ? {
        action: 'write',
        write: {
          kind: 'update', key: { pk: item.pk! }, updateExpression: 'SET #format = :format',
          names: { '#format': 'configFormat' }, values: { ':format': { S: 'legacy' } },
          condition: unchangedCondition(item, ['pk', 'configFormat']),
        },
      }
      : { action: 'write', write: { kind: 'delete', key: { pk: item.pk! }, condition: unchangedCondition(item, ['pk']) } });
    const m: Migration = {
      id: ID, phase: 'pre', description: 'u', run: async (ctx) => { await scanAndApply(ctx, { table: 'Things', key: ['pk'], plan: updatePlan }); },
    };
    expect((await run(history, 'write', { migrations: [m] })).exitCode).toBe(0);
    const update = ddb.commandCalls(UpdateItemCommand)[0]!.args[0].input;
    expect(update).toMatchObject({
      TableName: 'Things-dev',
      UpdateExpression: 'SET #format = :format',
      ConditionExpression: '#unchanged0 = :unchanged0 AND attribute_not_exists(#unchanged1)',
      ExpressionAttributeNames: { '#format': 'configFormat', '#unchanged0': 'pk', '#unchanged1': 'configFormat' },
      ExpressionAttributeValues: { ':format': { S: 'legacy' }, ':unchanged0': { S: 'k00' } },
    });
    expect(ddb.commandCalls(DeleteItemCommand)[0]!.args[0].input).toMatchObject({ Key: { pk: { S: 'k01' } }, ConditionExpression: '#unchanged0 = :unchanged0' });

    const clash: Migration = {
      ...m,
      id: '20261121-0931-clash',
      run: async (ctx) => {
        await scanAndApply(ctx, {
          table: 'Things', key: ['pk'], plan: (item) => ({
            action: 'write',
            write: {
              kind: 'update', key: { pk: item.pk! }, updateExpression: 'SET #unchanged0 = :v',
              names: { '#unchanged0': 'other' }, values: { ':v': { S: 'x' } }, condition: unchangedCondition(item, ['pk']),
            },
          }),
        });
      },
    };
    const clashed = await run(history, 'write', { migrations: [clash] });
    expect(clashed.migrations[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('#unchanged0') });
  });

  it('fails the migration when a planned write has no condition, or the plan throws', async () => {
    const table = new FakeTable(1);
    table.install();
    const noCondition: Migration = {
      id: ID, phase: 'pre', description: 'x', run: async (ctx) => {
        await scanAndApply(ctx, {
          table: 'Things', key: ['pk'],
          plan: (item) => ({ action: 'write', write: { kind: 'put', item, condition: { expression: '' } } }),
        });
      },
    };
    const result = await run(new InMemoryMigrationHistory(), 'write', { migrations: [noCondition] });
    expect(result.migrations[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('condition') });
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(0);

    const throwing: Migration = {
      ...noCondition, run: async (ctx) => {
        await scanAndApply(ctx, { table: 'Things', key: ['pk'], plan: () => { throw new Error('unexpected shape'); } });
      },
    };
    const thrown = await run(new InMemoryMigrationHistory(), 'dry-run', { migrations: [throwing] });
    expect(thrown.migrations[0]).toMatchObject({ status: 'failed', message: 'plan threw for Things pk=k00: unexpected shape' });
  });

  describe('validates every planned write in every mode', () => {
    const condition = (item: Item) => unchangedCondition(item, ['pk']);
    const update = (item: Item, extra: Record<string, unknown>) => ({
      kind: 'update', key: { pk: item.pk! }, updateExpression: 'SET #f = :f',
      names: { '#f': 'configFormat' }, values: { ':f': { S: 'legacy' } }, condition: condition(item), ...extra,
    });
    const cases: [string, (item: Item) => unknown, string][] = [
      ['no condition', (item) => ({ kind: 'put', item }), 'needs a condition expression'],
      ['a blank condition', (item) => ({ kind: 'delete', key: { pk: item.pk! }, condition: { expression: '  ' } }), 'needs a condition expression'],
      ['a name placeholder with no name', (item) => update(item, { names: {} }), '#f is used in an expression but has no expression attribute name'],
      ['a value placeholder with no value', (item) => update(item, { values: {} }), ':f is used in an expression but has no expression attribute value'],
      ['an unused name', (item) => update(item, { names: { '#f': 'configFormat', '#g': 'x' } }), '#g is defined but not used'],
      ['an unused value', (item) => update(item, { values: { ':f': { S: 'legacy' }, ':g': { S: 'x' } } }), ':g is defined but not used'],
      ['a name without #', (item) => update(item, { names: { '#f': 'configFormat', f: 'x' } }), 'is not a #placeholder'],
      ['a clash between update and condition', (item) => update(item, { names: { '#f': 'configFormat', '#unchanged0': 'other' }, updateExpression: 'SET #f = :f, #unchanged0 = :f' }), 'placeholder #unchanged0 is used with two different values'],
      ['a put condition with an undefined value', (item) => ({ kind: 'put', item, condition: { expression: '#a = :a', names: { '#a': 'pk' } } }), ':a is used'],
      ['an update with no update expression', (item) => update(item, { updateExpression: '' }), 'needs an update expression'],
      ['an unknown kind', (item) => ({ kind: 'upsert', item, condition: condition(item) }), 'unknown write kind'],
    ];
    const modes: [Mode, (string | undefined)[]][] = [['dry-run', []], ['check', []], ['write', ['k00']]];

    it.each(modes.flatMap(([mode, written]) => cases.map(([name, write, message]) => [mode, name, write, message, written] as const)))(
      '%s: %s fails the migration',
      async (mode, _name, write, message, written) => {
        const table = new FakeTable(3);
        table.install();
        ddb.on(UpdateItemCommand).resolves({}).on(DeleteItemCommand).resolves({});
        // k00 gets a valid write; k01 the malformed one.
        const badPlan = (item: Item): PlanResult => (item.pk!.S === 'k01'
          ? { action: 'write', write: write(item) as never }
          : plan(item));
        const m: Migration = {
          id: ID, phase: 'pre', description: 'x', run: async (ctx) => { await scanAndApply(ctx, { table: 'Things', key: ['pk'], plan: badPlan }); },
        };
        const history = new InMemoryMigrationHistory();
        const result = await run(history, mode, { migrations: [m] });
        expect(result.exitCode).toBe(1);
        expect(result.migrations[0]).toMatchObject({
          status: 'failed',
          message: expect.stringMatching(new RegExp(`^invalid write planned for Things pk=k01: .*${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
        });
        // Nothing past the bad item is written, and nothing at all outside write mode.
        expect(ddb.commandCalls(PutItemCommand).map((c) => c.args[0].input.Item!.pk!.S)).toEqual(written);
        expect(ddb.commandCalls(UpdateItemCommand)).toHaveLength(0);
        expect(ddb.commandCalls(DeleteItemCommand)).toHaveLength(0);
        if (mode === 'write') expect(await history.get(ID)).toMatchObject({ status: 'failed' });
        else expect(await history.list()).toEqual([]);
      },
    );

    it('sends no empty name or value map', async () => {
      const table = new FakeTable(1);
      table.install();
      const m: Migration = {
        id: ID, phase: 'pre', description: 'x', run: async (ctx) => {
          await scanAndApply(ctx, {
            table: 'Things', key: ['pk'],
            plan: (item) => ({ action: 'write', write: { kind: 'put', item, condition: { expression: 'attribute_exists(pk)', names: {}, values: {} } } }),
          });
        },
      };
      expect((await run(new InMemoryMigrationHistory(), 'write', { migrations: [m] })).exitCode).toBe(0);
      const put = ddb.commandCalls(PutItemCommand)[0]!.args[0].input;
      expect(put.ExpressionAttributeNames).toBeUndefined();
      expect(put.ExpressionAttributeValues).toBeUndefined();
    });
  });

  it('absentCondition guards a create', () => {
    expect(absentCondition('pk')).toEqual({ expression: 'attribute_not_exists(#absent)', names: { '#absent': 'pk' } });
  });
});
