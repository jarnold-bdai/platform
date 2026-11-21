import { describe, expect, it } from 'vitest';
import { LeaseLostError, UsageError, isLeaseLostError, isUsageError } from './types.js';

// A look-alike from another copy of the package: same name, different class.
class OtherUsageError extends Error {
  override name = 'UsageError';
}
class OtherLeaseLostError extends Error {
  override name = 'LeaseLostError';
}

describe('error detection', () => {
  it('recognises errors from this copy', () => {
    expect(isUsageError(new UsageError('x'))).toBe(true);
    expect(isLeaseLostError(new LeaseLostError('x'))).toBe(true);
  });

  it('recognises errors from a duplicated module copy, where instanceof fails', () => {
    const usage = new OtherUsageError('x');
    const lease = new OtherLeaseLostError('x');
    expect(usage instanceof UsageError).toBe(false);
    expect(isUsageError(usage)).toBe(true);
    expect(lease instanceof LeaseLostError).toBe(false);
    expect(isLeaseLostError(lease)).toBe(true);
  });

  it('rejects other values', () => {
    for (const value of [new Error('x'), null, undefined, 'UsageError', { name: 'Other' }]) {
      expect(isUsageError(value)).toBe(false);
      expect(isLeaseLostError(value)).toBe(false);
    }
    expect(isUsageError(new LeaseLostError('x'))).toBe(false);
  });
});
