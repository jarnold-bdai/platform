import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { EventEmitter } from 'node:events';
import { createMigrateCli, handleInterrupts, type MigrateCliOptions } from './cli.js';
import { InMemoryMigrationHistory, type HistoryRecord } from './history.js';
import type { Logger, Migration } from './types.js';

const T0 = new Date('2026-11-21T10:00:00.000Z');
const dynamo = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
const A = '20261120-0900-add-a';
const B = '20261121-0900-add-b';
const P = '20261121-1000-drop-old';

function setup(records: HistoryRecord[] = [], overrides: Partial<MigrateCliOptions> = {}) {
  const lines: string[] = [];
  const logger: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
  const ran: string[] = [];
  const m = (id: string, phase: 'pre' | 'post'): Migration => ({
    id, phase, description: `desc ${id}`, run: async (ctx) => { ran.push(`${id}:${ctx.mode}`); },
  });
  const history = new InMemoryMigrationHistory(records);
  const cli = createMigrateCli({
    migrations: [m(B, 'pre'), m(A, 'pre'), m(P, 'post')],
    dynamo,
    resolveTable: (name) => name,
    history,
    logger,
    now: () => T0,
    ...overrides,
  });
  return { cli, lines, ran, history, output: () => lines.join('\n') };
}

const dirs: string[] = [];
const tempFile = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-cli-'));
  dirs.push(dir);
  return join(dir, name);
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createMigrateCli', () => {
  it.each([
    [[], '--phase is required'],
    [['--phase', 'during'], '--phase must be one of'],
    [['--phase', 'pre', '--write', '--check'], 'cannot be combined'],
    [['--phase', 'pre', '--force'], "Unknown option '--force'"],
    [['--phase', 'pre', 'extra'], 'positional'],
    [['--list', '--write'], '--list takes no'],
    [['--phase', 'pre', '--only', '20990101-0000-nope'], 'no registered migration'],
  ])('exits 2 on a usage error: %j', async (argv, message) => {
    const { cli, output, ran } = setup();
    expect(await cli.run(argv)).toBe(2);
    expect(output()).toContain(message);
    expect(ran).toEqual([]);
  });

  it('dry run is the default, and --json writes the report', async () => {
    const { cli, ran, history, output } = setup();
    const json = tempFile('report.json');
    expect(await cli.run(['--phase', 'pre', '--json', json])).toBe(1);
    expect(ran).toEqual([`${A}:dry-run`, `${B}:dry-run`]);
    expect(await history.list()).toEqual([]);
    expect(output()).toContain('DRY RUN');
    const report = JSON.parse(readFileSync(json, 'utf8'));
    expect(report).toMatchObject({ phase: 'pre', mode: 'dry-run', exitCode: 1, migrations: [{ id: A, status: 'would-apply' }, { id: B }] });
  });

  it('--write applies the phase, then --check passes; --only limits the run', async () => {
    const { cli, ran } = setup();
    expect(await cli.run(['--phase', 'pre', '--only', A, '--write'])).toBe(0);
    expect(ran).toEqual([`${A}:write`]);
    expect(await cli.run(['--phase', 'pre', '--check'])).toBe(1);
    expect(await cli.run(['--phase', 'pre', '--write'])).toBe(0);
    expect(ran.at(-1)).toBe(`${B}:write`);
    expect(await cli.run(['--phase', 'pre', '--check'])).toBe(0);
    expect(await cli.run(['--phase', 'pre', '--check', '--only', B])).toBe(0);
    expect(ran.at(-1)).toBe(`${B}:check`);
  });

  it('--list shows each migration with its history status, and history-only ids', async () => {
    const { cli, output } = setup([
      { migrationId: A, status: 'applied', phase: 'pre', description: 'a', startedAt: T0.toISOString(), finishedAt: T0.toISOString(), attempts: 1 },
      { migrationId: B, status: 'running', phase: 'pre', description: 'b', startedAt: '2026-11-21T09:00:00.000Z',
        leaseExpiresAt: '2026-11-21T09:05:00.000Z', runnerId: 'r', attempts: 1 },
      { migrationId: '20250101-0000-removed', status: 'applied', phase: 'post', description: 'gone', startedAt: 'x', attempts: 1 },
    ]);
    const json = tempFile('list.json');
    expect(await cli.run(['--list', '--json', json])).toBe(0);
    const text = output();
    expect(text).toMatch(new RegExp(`${A}\\s+pre\\s+applied`));
    expect(text).toContain(`${B}  pre  running, stale since 2026-11-21T09:05:00.000Z`);
    expect(text).toMatch(new RegExp(`${P}\\s+post\\s+pending`));
    expect(text).toContain('20250101-0000-removed  post  applied  NOT REGISTERED');
    const listed = JSON.parse(readFileSync(json, 'utf8'));
    expect(listed.registered.map((r: { id: string; status: string }) => r.id)).toEqual([A, B, P]);
    expect(listed.unregistered[0].migrationId).toBe('20250101-0000-removed');

    const pre = setup();
    expect(await pre.cli.run(['--list', '--phase', 'post'])).toBe(0);
    expect(pre.output()).toContain(P);
    expect(pre.output()).not.toContain(A);
  });

  it('builds the DynamoDB history over historyTable, and exits 2 without one', async () => {
    const missing = setup([], { history: undefined });
    expect(await missing.cli.run(['--phase', 'pre'])).toBe(2);
    expect(missing.output()).toContain('history table');

    const ddb = mockClient(dynamo);
    ddb.onAnyCommand().rejects(Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException', $metadata: {} }));
    const real = setup([], { history: undefined, historyTable: 'MigrationHistory-dev' });
    expect(await real.cli.run(['--phase', 'pre'])).toBe(2);
    expect(await real.cli.run(['--list'])).toBe(2);
    expect(ddb.calls()[0]!.args[0].input).toMatchObject({ TableName: 'MigrationHistory-dev' });
    ddb.restore();
  });

  it('exits 2 when --json cannot be written', async () => {
    const { cli } = setup([{ migrationId: A, status: 'applied', phase: 'pre', description: 'a', startedAt: 'x', attempts: 1 },
      { migrationId: B, status: 'applied', phase: 'pre', description: 'b', startedAt: 'x', attempts: 1 }]);
    expect(await cli.run(['--phase', 'pre', '--json', join(tempFile('d'), 'missing', 'r.json')])).toBe(2);
  });

  it('--help prints the usage', async () => {
    const { cli, output } = setup();
    expect(await cli.run(['--help'])).toBe(0);
    expect(output()).toContain('Exit codes');
  });
});

describe('handleInterrupts', () => {
  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

  it('aborts on the first signal naming it, forces an exit on the second, and removes its handlers', () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const forced: number[] = [];
    const interrupts = handleInterrupts(controller, source, logger, (code) => forced.push(code));
    expect(interrupts.received()).toBeUndefined();

    source.emit('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe('interrupted by SIGTERM');
    expect(interrupts.received()).toBe('SIGTERM');
    expect(forced).toEqual([]);

    source.emit('SIGINT');
    expect(forced).toEqual([130]);

    interrupts.dispose();
    expect(source.listenerCount('SIGINT') + source.listenerCount('SIGTERM')).toBe(0);
  });

  it('an interrupted write run records the migration as failed and exits 1', async () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    handleInterrupts(controller, source, logger, () => {});
    const history = new InMemoryMigrationHistory();
    const { cli } = setup([], {
      history,
      migrations: [{
        id: A, phase: 'pre', description: 'd',
        run: async (ctx) => { source.emit('SIGINT'); ctx.signal.throwIfAborted(); },
      }],
    });
    expect(await cli.run(['--phase', 'pre', '--write'], controller.signal)).toBe(1);
    expect((await history.list())[0]).toMatchObject({ migrationId: A, status: 'failed', error: expect.stringContaining('interrupted by SIGINT') });
  });
});
