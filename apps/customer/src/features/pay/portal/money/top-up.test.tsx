import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { Resource } from '../../../../shared/resource';
import { parsePortalRoute } from '../routes';
import { TopUpView } from './TopUp';

const draw = (resource: Resource<never>) => renderToString(<TopUpView resource={resource} retry={() => undefined} />);
const refused = (code: string, reason: 'error' | 'unreachable' = 'error') =>
  ({ status: 'failed', failure: { ok: false, reason, code, message: code } }) as const;

describe('Top up (J-merchant-07 #5, M-money-out-02)', () => {
  it('lives at /pay/money/top-up', () => {
    expect(parsePortalRoute('/pay/money/top-up')).toEqual({ room: 'money-top-up' });
  });

  it('with no top-up rail: says it is not set up, keeps the form, and Request is off with the reason', () => {
    const out = draw(refused('pay.topup_unconfigured'));
    expect(out).toContain('Top up is not set up for your account');
    expect(out).toContain('Your balance is unchanged.');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Request<\/button>/);
    expect(out).toContain('Request is off because top up is not set up for your account.');
    expect(out).toMatch(/<input[^>]*disabled=""/);
    // No figure or instruction is made up: no asset amount, no address, nothing typed in.
    expect(out).not.toMatch(/USDT|USD\b|0x[0-9a-f]/i);
    expect(out).toMatch(/<input[^>]*value=""/);
  });

  it('any other failure is that failure, never the rail refusal, and Request stays off', () => {
    const out = draw(refused('pay.merchant_not_found'));
    expect(out).not.toContain('Top up is not set up for your account');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Request<\/button>/);
  });

  it('while loading Request is off', () => {
    expect(draw({ status: 'loading' })).toMatch(/<button[^>]*disabled=""[^>]*>Request<\/button>/);
  });
});
