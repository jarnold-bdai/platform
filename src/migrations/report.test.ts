import { describe, expect, it } from 'vitest';
import { Report, formatCounts } from './report.js';

describe('Report', () => {
  it('keeps exact counts and caps the entry lists', () => {
    const report = new Report(2);
    report.count('scanned', 5);
    report.count('written');
    for (const i of [1, 2, 3]) report.refuse(`item${i}`, 'bad');
    report.conflict('item9', 'changed');
    report.pending('item7', 'set x');
    const snap = report.snapshot();
    expect(snap.counts).toEqual({ scanned: 5, written: 1 });
    expect(snap.refusalCount).toBe(3);
    expect(snap.refusals).toHaveLength(2);
    expect(snap.conflictCount).toBe(1);
    expect(snap.pending).toEqual([{ item: 'item7', detail: 'set x' }]);
    expect(formatCounts(snap)).toBe('scanned=5 written=1 pending=1 refused=3 conflicts=1');
    expect(report.snapshot(1).refusals).toHaveLength(1);
  });
});
