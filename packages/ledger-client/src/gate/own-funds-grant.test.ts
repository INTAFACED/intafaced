import { describe, expect, it } from 'vitest';
import { grantFor, modulesFor } from './caller-allowlist.js';

describe('svc-trade own-funds grant (launch money model: Collect and Move own funds; J-campaigns-03)', () => {
  it('may collect builder fees in trade and move our own funds in treasury, and no other service may move them', () => {
    expect(grantFor('svc-trade', 'builderFeeReceive')).toEqual({
      module: 'trade',
      cite: 'services/svc-trade/src/builder-fee/builder-fee-collect.ts',
    });
    expect(grantFor('svc-trade', 'ownFundsMove')).toEqual({
      module: 'treasury',
      cite: 'services/svc-trade/src/builder-fee/own-funds-sweep.ts',
    });
    expect(modulesFor('svc-trade').has('treasury')).toBe(true);
    for (const other of ['svc-campaigns', 'svc-bank', 'svc-pay', 'svc-ops', 'svc-token'] as const) {
      expect(grantFor(other, 'ownFundsMove'), other).toBeUndefined();
    }
  });
});
