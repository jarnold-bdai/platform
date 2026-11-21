import { MODES, PHASES, UsageError, type Migration } from './types.js';

/**
 * Migration ids are `YYYYMMDD-HHMM-kebab-slug`, the date and time in UTC when
 * the migration was written, e.g. `20261121-0930-add-config-format`. The
 * fixed-width prefix makes lexical order chronological, which is the run order.
 * The slug is lower-case letters, digits and single hyphens.
 */
export const MIGRATION_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 100;

/** Why `id` is not a valid migration id, or null when it is. */
export function migrationIdProblem(id: unknown): string | null {
  if (typeof id !== 'string') return 'id is not a string';
  if (id.length > MAX_ID_LENGTH) return `id is longer than ${MAX_ID_LENGTH} characters`;
  const match = MIGRATION_ID_PATTERN.exec(id);
  if (!match) return 'id must look like YYYYMMDD-HHMM-kebab-slug (e.g. 20261121-0930-add-config-format)';
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return 'id date prefix is not a real date';
  }
  if (hour > 23 || minute > 59) return 'id time prefix is not a real time';
  return null;
}

export function validateMigrationId(id: unknown): void {
  const problem = migrationIdProblem(id);
  if (problem) throw new UsageError(`invalid migration id ${JSON.stringify(id)}: ${problem}`);
}

/** Checks every definition (id format, uniqueness, phase, description, run) and returns them in run order. */
export function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    const label = typeof migration?.id === 'string' ? migration.id : `#${index}`;
    const idProblem = migrationIdProblem(migration?.id);
    if (idProblem) problems.push(`${label}: ${idProblem}`);
    else if (seen.has(migration.id)) problems.push(`${label}: duplicate id`);
    else seen.add(migration.id);
    if (!PHASES.includes(migration?.phase)) problems.push(`${label}: phase must be one of ${PHASES.join(', ')}`);
    if (typeof migration?.description !== 'string' || migration.description.trim() === '') {
      problems.push(`${label}: description is required`);
    }
    if (typeof migration?.run !== 'function') problems.push(`${label}: run is not a function`);
  }
  if (problems.length > 0) throw new UsageError(`invalid migrations:\n  ${problems.join('\n  ')}`);
  return sortMigrations(migrations);
}

export function sortMigrations(migrations: readonly Migration[]): Migration[] {
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function assertMode(mode: unknown): asserts mode is (typeof MODES)[number] {
  if (!MODES.includes(mode as never)) throw new UsageError(`mode must be one of ${MODES.join(', ')}`);
}

export function assertPhase(phase: unknown): asserts phase is (typeof PHASES)[number] {
  if (!PHASES.includes(phase as never)) throw new UsageError(`phase must be one of ${PHASES.join(', ')}`);
}
