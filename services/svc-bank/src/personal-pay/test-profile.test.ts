import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseExchangeAllowance, parsePayeeControls, parseProofLimits } from './payee-controls.js';

const profile = JSON.parse(readFileSync(new URL('../../../../tooling/profiles/test-owner-values.json', import.meta.url), 'utf8')) as {
  values: Record<string, { service: string; value: string }>;
};
const value = (name: string): string => profile.values[name]!.value;

describe('the TEST owner profile for svc-bank holds', () => {
  it('is read as published by the service’s own parsers, so a journey does not meet the unset refusals', () => {
    expect(parsePayeeControls(value('BANK_PAYEE_CONTROLS_JSON'))?.blocked.has('TEST-BLOCKED-ACCOUNT')).toBe(true);
    const allowance = parseExchangeAllowance(value('BANK_EXCHANGE_ALLOWANCE_JSON'));
    expect(allowance?.accounts.has('TEST-EXCHANGE-ACCOUNT')).toBe(true);
    expect(allowance?.limits.get('USDT')).toBe('1000');
    expect(parseProofLimits(value('BANK_PROOF_LIMITS_JSON'))?.allowedTypes).toContain('application/pdf');
  });
  it('is filed under the bank service', () => {
    for (const name of ['BANK_PAYEE_CONTROLS_JSON', 'BANK_EXCHANGE_ALLOWANCE_JSON', 'BANK_PROOF_LIMITS_JSON']) {
      expect(profile.values[name]?.service).toBe('bank');
    }
  });
});
