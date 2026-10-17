import { describe, expect, it } from 'vitest';
import { merchantStarterFeeSchema } from './merchant-portal.js';

describe('merchantStarterFeeSchema', () => {
  it('accepts a local-test fee and refuses any other source', () => {
    expect(merchantStarterFeeSchema.parse({ bps: 250, source: 'local_test' })).toEqual({ bps: 250, source: 'local_test' });
    expect(merchantStarterFeeSchema.safeParse({ bps: 250, source: 'intafaced' }).success).toBe(false);
    expect(merchantStarterFeeSchema.safeParse({ bps: 2.5, source: 'local_test' }).success).toBe(false);
    expect(merchantStarterFeeSchema.safeParse({ bps: -1, source: 'local_test' }).success).toBe(false);
  });
});
