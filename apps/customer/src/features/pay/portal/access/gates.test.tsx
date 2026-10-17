import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

// TEST data only: nobody here is real. The two reads the provider makes are answered from `answers`.
const ME = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const answers: { myAccess: unknown; merchant: unknown } = { myAccess: null, merchant: null };
vi.mock('../../../session/session', () => ({ useSession: () => ({ api: {}, userId: ME }) }));
vi.mock('../../../../shared/resource', () => ({
  useResource: (_load: unknown, key: string) => ({
    resource: key.includes('my-access') ? answers.myAccess : key.includes('portal:merchant') ? answers.merchant : { status: 'loading' },
    reload: () => undefined,
  }),
}));

import { MerchantAccessProvider, Requires } from './MerchantAccess';
import { WithAccount } from './WithAccount';

const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const membership = {
  merchantId: MERCHANT,
  role: 'owner',
  status: 'active',
  kybStatus: 'approved',
  verified: true,
  sessionInteractive: true,
  mode: 'gateway',
  displayName: 'TEST Coffee',
  legalName: 'TEST Coffee Ltd',
  capabilities: { 'payments.read': true },
  pricingVisibility: 'full',
};
const record = (id: string) => ({ id, userId: ME, mode: 'gateway', status: 'active', kybStatus: 'approved', kybRef: null, feeBps: null });

beforeEach(() => {
  answers.myAccess = ready({ memberships: [membership] });
  answers.merchant = ready(record(MERCHANT));
});

describe('Requires', () => {
  it('shows the no-business state and never the page when the person has no business', () => {
    answers.myAccess = ready({ memberships: [] });
    const out = renderToString(
      <MerchantAccessProvider>
        <Requires need="owner">
          <p>SECRET PAGE BODY</p>
        </Requires>
      </MerchantAccessProvider>,
    );
    expect(out).not.toContain('SECRET PAGE BODY');
    expect(out).toContain('No business account yet');
    expect(out).toContain('href="/pay/onboarding"');
  });
  it('still draws the page for a person who holds the permission', () => {
    const out = renderToString(
      <MerchantAccessProvider>
        <Requires need="payments.read">
          <p>PAGE BODY</p>
        </Requires>
      </MerchantAccessProvider>,
    );
    expect(out).toContain('PAGE BODY');
  });
});

describe('WithAccount', () => {
  const seen = (): unknown[] => {
    const records: unknown[] = [];
    renderToString(
      <MerchantAccessProvider>
        <WithAccount>
          {({ record: r }) => {
            records.push(r);
            return null;
          }}
        </WithAccount>
      </MerchantAccessProvider>,
    );
    return records;
  };
  it('passes the owner record when it is the business the access resolved to', () => {
    expect(seen()).toEqual([expect.objectContaining({ id: MERCHANT })]);
  });
  it('passes a null record when the record belongs to a different business', () => {
    answers.merchant = ready(record(OTHER));
    expect(seen()).toEqual([null]);
  });
});
