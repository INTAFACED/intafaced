import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { tabPlan } from '@/lib/customer-record/record';
import { CustomerRecord } from './customer-record';

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const AS_OF = '2026-10-22T23:30:00.000Z';

describe('CustomerRecord', () => {
  it('draws all five tabs, marks the open one, and links each to the same account', () => {
    const plan = tabPlan('money', USER);
    const html = renderToStaticMarkup(
      <CustomerRecord userId={USER} founderId={USER} tab="money" reads={plan.reads} outcomes={{}} unwired={plan.unwired} />,
    );
    for (const tab of ['money', 'trade', 'pay', 'cards', 'tickets']) expect(html).toContain(`data-testid="customer-tab-${tab}"`);
    expect(html).toContain(`href="/accounts/${USER}?tab=trade"`);
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="customer-tab-money"/);
    expect(html).toContain('This part was not read');
  });
  it('refuses one read on its own while the one beside it shows', () => {
    const plan = tabPlan('pay', USER);
    const [mode, policy] = plan.reads;
    const html = renderToStaticMarkup(
      <CustomerRecord
        userId={USER}
        founderId={USER}
        tab="pay"
        reads={plan.reads}
        unwired={plan.unwired}
        outcomes={{
          [mode!.id]: {
            id: mode!.id,
            asOf: AS_OF,
            part: { kind: 'failed', message: 'svc-pay did not answer.', code: null, notBuilt: false, forbidden: false },
          },
          [policy!.id]: {
            id: policy!.id,
            asOf: AS_OF,
            part: {
              kind: 'ok',
              data: {
                shape: 'record',
                cells: [{ key: 'enabled', label: 'One-time sends allowed', kind: 'bool', detail: false, value: false }],
              },
            },
          },
        }}
      />,
    );
    expect(html).toContain('svc-pay did not answer.');
    expect(html).toContain('One-time sends allowed');
    expect(html).toContain('Payments sent and received: no source');
  });
  it('says why cards and tickets cannot be read for one account, with the code', () => {
    for (const tab of ['cards', 'tickets'] as const) {
      const plan = tabPlan(tab, USER);
      const html = renderToStaticMarkup(
        <CustomerRecord userId={USER} founderId={USER} tab={tab} reads={plan.reads} outcomes={{}} unwired={plan.unwired} />,
      );
      expect(html).toContain('ops.customer_record_source_unwired');
      expect(html).toContain('no source');
    }
  });
});
