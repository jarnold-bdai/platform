import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InMemoryMigrationHistory, type HistoryRecord } from './history.js';
import { runMigrations, type RunOptions } from './runner.js';
import type { Logger, Migration, MigrationContext, Mode, Phase } from './types.js';

const T0 = new Date('2026-11-21T10:00:00.000Z');
const dynamo = new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } });
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** A migration that records each call; `body` decides what it reports. */
function migration(id: string, phase: Phase, calls: string[], body?: (ctx: MigrationContext) => Promise<void> | void): Migration {
  return {
    id,
    phase,
    description: `migration ${id}`,
    run: async (ctx) => {
      calls.push(`${id}:${ctx.mode}`);
      await body?.(ctx);
    },
  };
}

const applied = (id: string, phase: Phase = 'pre'): HistoryRecord => ({
  migrationId: id, status: 'applied', phase, description: id, startedAt: T0.toISOString(), finishedAt: T0.toISOString(), attempts: 1,
});

function options(migrations: Migration[], history: InMemoryMigrationHistory, mode: Mode, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    migrations, phase: 'pre', mode, dynamo, history, logger: silent, resolveTable: (name) => `${name}-dev`, now: () => T0, ...extra,
  };
}

const A = '20261120-0900-a';
const B = '20261121-0900-b';
const C = '20261121-1000-c';
const P = '20261119-0900-post';

describe('runMigrations', () => {
  it('runs only the pending migrations of the phase, in id order', async () => {
    const calls: string[] = [];
    const history = new InMemoryMigrationHistory([applied(A)]);
    const migrations = [migration(C, 'pre', calls), migration(P, 'post', calls), migration(B, 'pre', calls), migration(A, 'pre', calls)];
    const result = await runMigrations(options(migrations, history, 'write'));
    expect(calls).toEqual([`${B}:write`, `${C}:write`]);
    expect(result.migrations.map((m) => [m.id, m.status])).toEqual([[A, 'already-applied'], [B, 'applied'], [C, 'applied']]);
    expect(result.exitCode).toBe(0);
    expect((await history.get(B))?.status).toBe('applied');
    expect(await history.get(P)).toBeUndefined();

    const post = await runMigrations(options(migrations, history, 'write', { phase: 'post' }));
    expect(post.migrations.map((m) => m.id)).toEqual([P]);
    expect(calls.at(-1)).toBe(`${P}:write`);
  });

  it('dry run writes nothing to the history and exits 1 while anything is pending', async () => {
    const calls: string[] = [];
    const history = new InMemoryMigrationHistory();
    const migrations = [migration(A, 'pre', calls, async (ctx) => {
      ctx.report.pending('item1', 'set x');
      await ctx.checkpoint.save('slot', { at: 1 });
      expect(await ctx.checkpoint.load('slot')).toEqual({ at: 1 });
    })];
    const result = await runMigrations(options(migrations, history, 'dry-run'));
    expect(result.exitCode).toBe(1);
    expect(result.migrations[0]).toMatchObject({ status: 'would-apply', report: { pendingCount: 1 } });
    expect(await history.list()).toEqual([]);
    expect(calls).toEqual([`${A}:dry-run`]);
  });

  it('exits 0 when nothing is pending, and with no migrations at all', async () => {
    const calls: string[] = [];
    const history = new InMemoryMigrationHistory([applied(A)]);
    for (const mode of ['dry-run', 'write', 'check'] as const) {
      expect((await runMigrations(options([migration(A, 'pre', calls)], history, mode))).exitCode).toBe(0);
      expect((await runMigrations(options([], history, mode))).exitCode).toBe(0);
    }
    expect(calls).toEqual([]);
  });

  it('a second runner is refused while the first holds the claim', async () => {
    const history = new InMemoryMigrationHistory();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { markStarted = r; });
    const slow: Migration = { id: A, phase: 'pre', description: 'slow', run: async () => { markStarted(); await gate; } };
    const firstRun = runMigrations(options([slow, migration(B, 'pre', [])], history, 'write', { runnerId: 'r1' }));
    await started;

    const calls: string[] = [];
    const second = await runMigrations(options([migration(A, 'pre', calls), migration(B, 'pre', calls)], history, 'write', { runnerId: 'r2' }));
    expect(second.exitCode).toBe(1);
    expect(second.migrations.map((m) => m.status)).toEqual(['locked', 'not-run']);
    expect(second.migrations[0]!.message).toContain('r1');
    expect(calls).toEqual([]);

    release();
    const first = await firstRun;
    expect(first.exitCode).toBe(0);
    expect((await history.get(A))?.status).toBe('applied');
  });

  it('takes over a stale running claim left by a crash, and resumes from its checkpoint', async () => {
    const history = new InMemoryMigrationHistory([{
      migrationId: A, status: 'running', phase: 'pre', description: A, startedAt: '2026-11-21T09:00:00.000Z',
      heartbeatAt: '2026-11-21T09:01:00.000Z', leaseExpiresAt: '2026-11-21T09:06:00.000Z', runnerId: 'crashed',
      attempts: 1, checkpoint: { progress: { done: 40 } },
    }]);
    let resumedFrom: unknown;
    const m = migration(A, 'pre', [], async (ctx) => { resumedFrom = await ctx.checkpoint.load('progress'); });
    const result = await runMigrations(options([m], history, 'write'));
    expect(result.exitCode).toBe(0);
    expect(resumedFrom).toEqual({ done: 40 });
    expect(await history.get(A)).toMatchObject({ status: 'applied', attempts: 2 });
  });

  it('does not take over a running claim whose lease is still live', async () => {
    const history = new InMemoryMigrationHistory([{
      migrationId: A, status: 'running', phase: 'pre', description: A, startedAt: T0.toISOString(),
      leaseExpiresAt: '2026-11-21T10:04:00.000Z', runnerId: 'other', attempts: 1,
    }]);
    const calls: string[] = [];
    const result = await runMigrations(options([migration(A, 'pre', calls)], history, 'write'));
    expect(result.migrations[0]!.status).toBe('locked');
    expect(result.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it('stops at the first failure, records it, and retries it on the next run', async () => {
    const history = new InMemoryMigrationHistory();
    const calls: string[] = [];
    let fail = true;
    const migrations = [
      migration(A, 'pre', calls, () => { if (fail) throw new Error('bug in the migration'); }),
      migration(B, 'pre', calls),
    ];
    const result = await runMigrations(options(migrations, history, 'write'));
    expect(result.exitCode).toBe(1);
    expect(result.migrations.map((m) => m.status)).toEqual(['failed', 'not-run']);
    expect(await history.get(A)).toMatchObject({ status: 'failed', error: 'bug in the migration' });
    expect(calls).toEqual([`${A}:write`]);

    fail = false;
    const retry = await runMigrations(options(migrations, history, 'write'));
    expect(retry.exitCode).toBe(0);
    expect(await history.get(A)).toMatchObject({ status: 'applied', attempts: 2 });
  });

  it('stops at refusals and conflicts with exit 1 and records the attempt as failed', async () => {
    for (const [kind, status] of [['refuse', 'refused'], ['conflict', 'conflict']] as const) {
      const history = new InMemoryMigrationHistory();
      const calls: string[] = [];
      const migrations = [
        migration(A, 'pre', calls, (ctx) => { ctx.report[kind]('pk=1', 'why'); }),
        migration(B, 'pre', calls),
      ];
      for (const mode of ['dry-run', 'write', 'check'] as const) {
        const result = await runMigrations(options(migrations, history, mode));
        expect(result.exitCode).toBe(1);
        expect(result.migrations.map((m) => m.status)).toEqual([status, 'not-run']);
      }
      expect(await history.get(A)).toMatchObject({ status: 'failed' });
      expect(calls).not.toContain(`${B}:write`);
    }
  });

  it('exits 2 for an AWS error', async () => {
    const history = new InMemoryMigrationHistory();
    const awsError = Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException', $metadata: {}, $fault: 'client' });
    const result = await runMigrations(options([migration(A, 'pre', [], () => { throw awsError; })], history, 'write'));
    expect(result.exitCode).toBe(2);
    expect(result.migrations[0]).toMatchObject({ status: 'failed', message: 'ResourceNotFoundException: Requested resource not found' });
  });

  it('exits 2 when the history itself fails', async () => {
    const history = new InMemoryMigrationHistory();
    history.list = async () => { throw Object.assign(new Error('no credentials'), { name: 'CredentialsProviderError' }); };
    const result = await runMigrations(options([migration(A, 'pre', [])], history, 'dry-run'));
    expect(result).toMatchObject({ exitCode: 2, error: 'CredentialsProviderError: no credentials' });
  });

  it.each([
    ['an invalid id', [{ id: 'add-x', phase: 'pre', description: 'x', run: async () => {} }], {}],
    ['a duplicate id', [migration(A, 'pre', []), migration(A, 'post', [])], {}],
    ['an unknown --only', [migration(A, 'pre', [])], { only: B }],
    ['--only of the other phase', [migration(P, 'post', [])], { only: P }],
    ['a bad phase', [migration(A, 'pre', [])], { phase: 'during' }],
    ['a bad mode', [migration(A, 'pre', [])], { mode: 'apply' }],
    ['a heartbeat too close to the lease', [migration(A, 'pre', [])], { leaseMs: 100, heartbeatMs: 95 }],
  ])('exits 2 for a usage error: %s', async (_name, migrations, extra) => {
    const history = new InMemoryMigrationHistory();
    const result = await runMigrations({ ...options(migrations as Migration[], history, 'write'), ...(extra as Partial<RunOptions>) });
    expect(result.exitCode).toBe(2);
    expect(result.error).toBeDefined();
    expect(await history.list()).toEqual([]);
  });

  it('exits 2 when the consumer cannot resolve a table', async () => {
    const history = new InMemoryMigrationHistory();
    const m = migration(A, 'pre', [], (ctx) => { ctx.tableName('Missing'); });
    const result = await runMigrations(options([m], history, 'dry-run', { resolveTable: () => undefined }));
    expect(result.exitCode).toBe(2);
    expect(result.migrations[0]!.message).toContain('Missing');
  });

  it('reports applied history ids that are no longer registered without failing', async () => {
    const history = new InMemoryMigrationHistory([applied(A), applied('20250101-0000-deleted')]);
    const result = await runMigrations(options([migration(A, 'pre', [])], history, 'check'));
    expect(result.exitCode).toBe(0);
    expect(result.unregistered).toEqual([{ migrationId: '20250101-0000-deleted', status: 'applied', phase: 'pre', finishedAt: T0.toISOString() }]);
  });

  describe('check mode', () => {
    it('fails for a pending migration, even one with nothing to write, and records nothing', async () => {
      const history = new InMemoryMigrationHistory();
      const clean = await runMigrations(options([migration(A, 'pre', [])], history, 'check'));
      expect(clean.exitCode).toBe(1);
      expect(clean.migrations[0]).toMatchObject({ status: 'check-failed', message: expect.stringContaining('not recorded') });

      const dirty = await runMigrations(options([migration(A, 'pre', [], (ctx) => ctx.report.pending('pk=1'))], history, 'check'));
      expect(dirty.migrations[0]).toMatchObject({ status: 'check-failed', message: '1 item(s) to write' });
      expect(await history.list()).toEqual([]);
    });

    it('re-checks an applied migration named with --only', async () => {
      const history = new InMemoryMigrationHistory([applied(A)]);
      const calls: string[] = [];
      const passed = await runMigrations(options([migration(A, 'pre', calls)], history, 'check', { only: A }));
      expect(passed.migrations[0]!.status).toBe('check-passed');
      expect(passed.exitCode).toBe(0);
      expect(calls).toEqual([`${A}:check`]);

      const stragglers = await runMigrations(options([migration(A, 'pre', [], (ctx) => ctx.report.pending('pk=9'))], history, 'check', { only: A }));
      expect(stragglers.exitCode).toBe(1);
      // --only in write mode does not re-run an applied migration.
      const write = await runMigrations(options([migration(A, 'pre', calls)], history, 'write', { only: A }));
      expect(write.migrations[0]!.status).toBe('already-applied');
    });
  });

  it('aborts and fails a migration whose claim is taken over while it runs', async () => {
    const history = new InMemoryMigrationHistory();
    let clock = T0.getTime();
    const m = migration(A, 'pre', [], async (ctx) => {
      // Simulate this runner stalling past its lease, and another runner taking over.
      clock += 120;
      expect((await history.claim({ migrationId: A, phase: 'pre', description: A, runnerId: 'thief', now: new Date(clock), leaseMs: 100 })).claimed).toBe(true);
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      ctx.signal.throwIfAborted();
    });
    const result = await runMigrations(options([m], history, 'write', { leaseMs: 100, heartbeatMs: 5, now: () => new Date(clock), runnerId: 'me' }));
    expect(result.exitCode).toBe(1);
    expect(result.migrations[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('lost the claim') });
    expect(await history.get(A)).toMatchObject({ status: 'running', runnerId: 'thief' });
  });

  describe('lease watchdog (fake timers)', () => {
    const LEASE = 1000;
    const BEAT = 200; // heartbeat timeout: 100; the runner stops 100 before the lease ends
    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Runs one migration that waits for its signal; returns when it aborted and the stored lease at that moment. */
    async function runUntilAborted(history: InMemoryMigrationHistory) {
      let abortedAt: number | undefined;
      let storedLeaseEnd: number | undefined;
      const m = migration(A, 'pre', [], async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
        abortedAt = Date.now();
        storedLeaseEnd = Date.parse((await history.get(A))!.leaseExpiresAt!);
        ctx.signal.throwIfAborted();
      });
      const running = runMigrations(options([m], history, 'write', { leaseMs: LEASE, heartbeatMs: BEAT, now: () => new Date(), runnerId: 'me' }));
      await vi.advanceTimersByTimeAsync(3 * LEASE);
      const result = await running;
      return { result, abortedAt: abortedAt!, storedLeaseEnd: storedLeaseEnd! };
    }

    it('stops before the lease ends when a heartbeat hangs, and keeps retrying past the hung request', async () => {
      const history = new InMemoryMigrationHistory();
      const signals: (AbortSignal | undefined)[] = [];
      history.heartbeat = (_id, _runner, _now, _lease, signal) => {
        signals.push(signal);
        return new Promise<boolean>(() => {}); // never settles, and ignores its signal
      };
      const { result, abortedAt, storedLeaseEnd } = await runUntilAborted(history);
      expect(storedLeaseEnd).toBe(T0.getTime() + LEASE);
      expect(abortedAt).toBe(T0.getTime() + LEASE - 100);
      expect(result.migrations[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('lease ran out') });
      expect(result.exitCode).toBe(1);
      // Heartbeats at 200, 400, 600 and 800: each hung one was abandoned, with its request aborted.
      expect(signals).toHaveLength(4);
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      expect(await history.get(A)).toMatchObject({ status: 'failed' });
    });

    it('counts a slow heartbeat from when it was sent, not from when its reply arrived', async () => {
      const history = new InMemoryMigrationHistory();
      const renew = history.heartbeat.bind(history);
      let calls = 0;
      history.heartbeat = async (id, runner, now, lease) => {
        calls += 1;
        if (calls > 1) throw new Error('network down');
        const held = await renew(id, runner, now, lease); // stored at once, with the send time
        await new Promise((resolve) => setTimeout(resolve, 90)); // the reply comes 90 ms later
        return held;
      };
      const { result, abortedAt, storedLeaseEnd } = await runUntilAborted(history);
      // Sent at 200: the stored lease ends at 1200, so the runner stops at 1100 (counting from the reply, it would be 1190).
      expect(storedLeaseEnd).toBe(T0.getTime() + BEAT + LEASE);
      expect(abortedAt).toBe(T0.getTime() + BEAT + LEASE - 100);
      expect(abortedAt).toBeLessThan(storedLeaseEnd);
      expect(result.migrations[0]!.status).toBe('failed');
    });

    it('stops before the lease ends when every heartbeat fails', async () => {
      const history = new InMemoryMigrationHistory();
      let calls = 0;
      history.heartbeat = async () => {
        calls += 1;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      };
      const { result, abortedAt, storedLeaseEnd } = await runUntilAborted(history);
      expect(calls).toBe(4);
      expect(abortedAt).toBe(T0.getTime() + LEASE - 100);
      expect(abortedAt).toBeLessThan(storedLeaseEnd);
      expect(result.migrations[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('lease ran out') });
    });

    it('keeps running while renewals succeed, and a checkpoint save renews from its send time', async () => {
      const history = new InMemoryMigrationHistory();
      let aborted = false;
      const m = migration(A, 'pre', [], async (ctx) => {
        for (let i = 0; i < 10; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          await ctx.checkpoint.save('progress', { i });
        }
        aborted = ctx.signal.aborted;
      });
      const running = runMigrations(options([m], history, 'write', { leaseMs: LEASE, heartbeatMs: BEAT, now: () => new Date() }));
      await vi.advanceTimersByTimeAsync(3 * LEASE);
      const result = await running;
      expect(aborted).toBe(false);
      expect(result.migrations[0]!.status).toBe('applied');
    });
  });
});
