import { describe, expect, it } from 'vitest';
import * as mod from './index.js';

describe('migrations entry point', () => {
  it('exports the runner, the helper, both histories and the CLI factory', () => {
    for (const name of [
      'runMigrations', 'scanAndApply', 'createMigrateCli', 'DynamoDbMigrationHistory', 'InMemoryMigrationHistory',
      'validateMigrations', 'unchangedCondition', 'absentCondition', 'UsageError',
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });
});
