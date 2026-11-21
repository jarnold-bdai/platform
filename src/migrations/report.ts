import type { MigrationReport, ReportCollector, ReportEntry } from './types.js';

/** How many entries of each kind a report keeps; the counts stay exact. */
export const REPORT_ENTRY_LIMIT = 1000;
/** How many entries of each kind the history summary keeps (the item must stay small). */
export const SUMMARY_ENTRY_LIMIT = 20;

export class Report implements ReportCollector {
  private readonly counts: Record<string, number> = {};
  private readonly entries = { pending: [] as ReportEntry[], refusals: [] as ReportEntry[], conflicts: [] as ReportEntry[] };
  private readonly totals = { pending: 0, refusals: 0, conflicts: 0 };

  constructor(private readonly limit = REPORT_ENTRY_LIMIT) {}

  count(name: string, by = 1): void {
    this.counts[name] = (this.counts[name] ?? 0) + by;
  }

  pending(item: string, detail = ''): void {
    this.add('pending', item, detail);
  }

  refuse(item: string, reason: string): void {
    this.add('refusals', item, reason);
  }

  conflict(item: string, detail: string): void {
    this.add('conflicts', item, detail);
  }

  private add(kind: keyof Report['totals'], item: string, detail: string): void {
    this.totals[kind] += 1;
    if (this.entries[kind].length < this.limit) this.entries[kind].push({ item, detail });
  }

  get pendingCount(): number {
    return this.totals.pending;
  }

  get refusalCount(): number {
    return this.totals.refusals;
  }

  get conflictCount(): number {
    return this.totals.conflicts;
  }

  snapshot(limit = this.limit): MigrationReport {
    return {
      counts: { ...this.counts },
      pendingCount: this.totals.pending,
      refusalCount: this.totals.refusals,
      conflictCount: this.totals.conflicts,
      pending: this.entries.pending.slice(0, limit),
      refusals: this.entries.refusals.slice(0, limit),
      conflicts: this.entries.conflicts.slice(0, limit),
    };
  }
}

/** `scanned=10 written=3 pending=0 refused=1` style one-liner. */
export function formatCounts(report: MigrationReport): string {
  const parts = Object.entries(report.counts).map(([name, n]) => `${name}=${n}`);
  if (report.pendingCount > 0) parts.push(`pending=${report.pendingCount}`);
  if (report.refusalCount > 0) parts.push(`refused=${report.refusalCount}`);
  if (report.conflictCount > 0) parts.push(`conflicts=${report.conflictCount}`);
  return parts.join(' ');
}
