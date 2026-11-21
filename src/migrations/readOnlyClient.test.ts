import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchExecuteStatementCommand,
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TagResourceCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDbMigrationHistory, InMemoryMigrationHistory, type MigrationHistory } from './history.js';
import { ReadOnlyModeError, readOnlyDynamo } from './readOnlyClient.js';
import { runMigrations } from './runner.js';
import type { Logger, Migration, MigrationContext, Mode } from './types.js';

const client = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
const ddb = mockClient(client);
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const key = { pk: { S: 'k' } };
const ID = '20261121-0930-custom';

beforeEach(() => {
  ddb.reset();
  ddb.onAnyCommand().resolves({});
});

const reads = [
  new GetItemCommand({ TableName: 't', Key: key }),
  new BatchGetItemCommand({ RequestItems: { t: { Keys: [key] } } }),
  new QueryCommand({ TableName: 't', KeyConditionExpression: '#pk = :pk' }),
  new ScanCommand({ TableName: 't' }),
  new TransactGetItemsCommand({ TransactItems: [{ Get: { TableName: 't', Key: key } }] }),
  new DescribeTableCommand({ TableName: 't' }),
  new ListTablesCommand({}),
  new ExecuteStatementCommand({ Statement: '  select * from "t" where pk = ?' }),
  new BatchExecuteStatementCommand({ Statements: [{ Statement: 'SELECT * FROM "t"' }, { Statement: 'SELECT pk FROM "u"' }] }),
  new ExecuteTransactionCommand({ TransactStatements: [{ Statement: 'SELECT * FROM "t" WHERE pk = ?' }] }),
];

const writes: [string, { input: unknown }][] = [
  ['PutItemCommand', new PutItemCommand({ TableName: 't', Item: key })],
  ['UpdateItemCommand', new UpdateItemCommand({ TableName: 't', Key: key, UpdateExpression: 'SET a = :a' })],
  ['DeleteItemCommand', new DeleteItemCommand({ TableName: 't', Key: key })],
  ['BatchWriteItemCommand', new BatchWriteItemCommand({ RequestItems: { t: [{ PutRequest: { Item: key } }] } })],
  ['TransactWriteItemsCommand', new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: 't', Item: key } }] })],
  ['ExecuteStatementCommand', new ExecuteStatementCommand({ Statement: 'UPDATE "t" SET a = 1 WHERE pk = ?' })],
  ['ExecuteStatementCommand', new ExecuteStatementCommand({ Statement: '-- SELECT\nDELETE FROM "t" WHERE pk = ?' })],
  ['BatchExecuteStatementCommand', new BatchExecuteStatementCommand({ Statements: [{ Statement: 'SELECT * FROM "t"' }, { Statement: 'INSERT INTO "t" VALUE {\'pk\': ?}' }] })],
  ['ExecuteTransactionCommand', new ExecuteTransactionCommand({ TransactStatements: [{ Statement: 'UPDATE "t" SET a = 1 WHERE pk = ?' }] })],
  ['CreateTableCommand', new CreateTableCommand({ TableName: 't', KeySchema: [], AttributeDefinitions: [] })],
  ['UpdateTableCommand', new UpdateTableCommand({ TableName: 't' })],
  ['DeleteTableCommand', new DeleteTableCommand({ TableName: 't' })],
  ['UpdateTimeToLiveCommand', new UpdateTimeToLiveCommand({ TableName: 't', TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' } })],
  ['TagResourceCommand', new TagResourceCommand({ ResourceArn: 'arn', Tags: [] })],
];

describe('readOnlyDynamo', () => {
  it.each(['dry-run', 'check'] as const)('%s: lets every read through to the caller\'s client', async (mode) => {
    const readOnly = readOnlyDynamo(client, mode);
    for (const command of reads) await readOnly.send(command as never);
    expect(ddb.calls()).toHaveLength(reads.length);
  });

  it.each((['dry-run', 'check'] as const).flatMap((mode) => writes.map(([name, command]) => [mode, name, command] as const)))(
    '%s: refuses %s, naming the mode and the command',
    async (mode, name, command) => {
      const readOnly = readOnlyDynamo(client, mode);
      const sent = readOnly.send(command as never);
      await expect(sent).rejects.toThrow(ReadOnlyModeError);
      await expect(sent).rejects.toThrow(new RegExp(`^${mode} is read-only: ctx\\.dynamo refused ${name}`));
      expect(ddb.calls()).toHaveLength(0);
    },
  );

  it('refuses a command it does not know', async () => {
    class SomeNewCommand { input = {}; }
    await expect(readOnlyDynamo(client, 'check').send(new SomeNewCommand() as never)).rejects.toThrow('refused SomeNewCommand');
    expect(ddb.calls()).toHaveLength(0);
  });

  it('refuses through the callback form of send too', async () => {
    const error = await new Promise((resolve) => {
      readOnlyDynamo(client, 'dry-run').send(new PutItemCommand({ TableName: 't', Item: key }), (err: unknown) => resolve(err));
    });
    expect(error).toBeInstanceOf(ReadOnlyModeError);
  });

  it('leaves the caller\'s own client able to write', async () => {
    readOnlyDynamo(client, 'dry-run');
    await client.send(new PutItemCommand({ TableName: 't', Item: key }));
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it('guards a client built on its middleware stack (as DynamoDBDocumentClient.from does)', async () => {
    const readOnly = readOnlyDynamo(client, 'dry-run');
    // Stand in for the network so a read can complete here.
    const stack = readOnly.middlewareStack.clone();
    stack.add(() => async () => ({ output: { $metadata: {} }, response: {} }), { step: 'build', name: 'noNetwork' });
    const handle = (command: GetItemCommand | PutItemCommand) =>
      (command.resolveMiddleware as (...args: unknown[]) => (c: unknown) => Promise<unknown>)(stack, readOnly.config, undefined)(command);
    await expect(handle(new GetItemCommand({ TableName: 't', Key: key }))).resolves.toBeDefined();
    await expect(handle(new PutItemCommand({ TableName: 't', Item: key }))).rejects.toThrow('dry-run is read-only: ctx.dynamo refused PutItemCommand');
    // The caller's own stack is untouched.
    expect(client.middlewareStack.identify().some((entry) => entry.includes('migrationReadOnlyGuard'))).toBe(false);
  });
});

describe('the context client in each mode', () => {
  const custom = (onRun: (ctx: MigrationContext) => Promise<void>): Migration => ({ id: ID, phase: 'pre', description: 'custom', run: onRun });
  const runIn = (mode: Mode, migration: Migration, history: MigrationHistory = new InMemoryMigrationHistory()) => runMigrations({
    migrations: [migration], phase: 'pre', mode, dynamo: client, history, logger: silent, resolveTable: (name) => name,
  });

  it.each(['dry-run', 'check'] as const)('%s: a migration that writes through ctx.dynamo without checking ctx.mode fails, and nothing is written', async (mode) => {
    const careless = custom(async (ctx) => {
      await ctx.dynamo.send(new ScanCommand({ TableName: ctx.tableName('T') }));
      await ctx.dynamo.send(new PutItemCommand({ TableName: ctx.tableName('T'), Item: key }));
    });
    const result = await runIn(mode, careless);
    expect(result.exitCode).toBe(1);
    expect(result.migrations[0]).toMatchObject({
      status: 'failed',
      message: `ReadOnlyModeError: ${mode} is read-only: ctx.dynamo refused PutItemCommand. Write only when ctx.mode === 'write', `
        + 'and call ctx.report.pending() for what you would write.',
    });
    expect(ddb.commandCalls(ScanCommand)).toHaveLength(1);
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('write: ctx.dynamo is the caller\'s client', async () => {
    let dynamo: unknown;
    const result = await runIn('write', custom(async (ctx) => {
      dynamo = ctx.dynamo;
      await ctx.dynamo.send(new PutItemCommand({ TableName: 'T', Item: key }));
    }));
    expect(result.exitCode).toBe(0);
    expect(dynamo).toBe(client);
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it.each(['dry-run', 'check'] as const)('%s: never writes to the history', async (mode) => {
    const history = new InMemoryMigrationHistory();
    const written: string[] = [];
    for (const method of ['claim', 'heartbeat', 'saveCheckpoint', 'finish'] as const) {
      history[method] = async () => {
        written.push(method);
        throw new Error(`history.${method} called in ${mode}`);
      };
    }
    const busy = custom(async (ctx) => {
      ctx.report.pending('pk=1', 'would set x');
      await ctx.checkpoint.save('slot', { at: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const result = await runMigrations({
      migrations: [busy], phase: 'pre', mode, dynamo: client, history, logger: silent, resolveTable: (name) => name,
      leaseMs: 10, heartbeatMs: 2,
    });
    expect(result.migrations[0]!.status).toBe(mode === 'dry-run' ? 'would-apply' : 'check-failed');
    expect(written).toEqual([]);
  });

  it.each(['dry-run', 'check'] as const)('%s: the DynamoDB history only scans its table', async (mode) => {
    const history = new DynamoDbMigrationHistory({ dynamo: client, tableName: 'History' });
    const busy = custom(async (ctx) => {
      ctx.report.pending('pk=1');
      await ctx.checkpoint.save('slot', { at: 1 });
    });
    await runIn(mode, busy, history);
    expect(ddb.calls().map((call) => (call.args[0] as { constructor: { name: string } }).constructor.name)).toEqual(['ScanCommand']);
  });
});
