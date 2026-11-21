import { describe, expect, it } from 'vitest';
import { migrationIdProblem, validateMigrations } from './id.js';
import { UsageError, type Migration } from './types.js';

const m = (id: string, extra: Partial<Migration> = {}): Migration => ({
  id, phase: 'pre', description: 'd', run: async () => {}, ...extra,
});

describe('migration ids', () => {
  it.each(['20261121-0930-add-config-format', '20240229-0000-a', '20261231-2359-x1-y2'])('accepts %s', (id) => {
    expect(migrationIdProblem(id)).toBeNull();
  });

  it.each([
    ['2026-11-21-add', 'look like'],
    ['20261121-930-add', 'look like'],
    ['20261121-0930-Add', 'look like'],
    ['20261121-0930-add--x', 'look like'],
    ['20261121-0930-add-', 'look like'],
    ['20261121-0930', 'look like'],
    ['20230229-0930-add', 'real date'],
    ['20261301-0930-add', 'real date'],
    ['20261121-2400-add', 'real time'],
    ['20261121-1260-add', 'real time'],
    [`20261121-0930-${'a'.repeat(100)}`, 'longer'],
  ])('rejects %s', (id, problem) => {
    expect(migrationIdProblem(id)).toContain(problem);
  });

  it('sorts by id and rejects duplicates and bad definitions', () => {
    const sorted = validateMigrations([m('20261121-1000-b'), m('20261120-2300-a'), m('20261121-0900-c')]);
    expect(sorted.map((x) => x.id)).toEqual(['20261120-2300-a', '20261121-0900-c', '20261121-1000-b']);

    expect(() => validateMigrations([m('20261121-1000-b'), m('20261121-1000-b')])).toThrow(/duplicate id/);
    expect(() => validateMigrations([m('20261121-1000-b', { phase: 'during' as never })])).toThrow(UsageError);
    expect(() => validateMigrations([m('20261121-1000-b', { description: ' ' })])).toThrow(/description/);
    expect(() => validateMigrations([m('20261121-1000-b', { run: undefined as never })])).toThrow(/run/);
  });
});
