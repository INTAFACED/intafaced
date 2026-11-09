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
    for (const tab of ['money', 'trade', 'pay', 'cards', 'documents', 'tickets'])
      expect(html).toContain(`data-testid="customer-tab-${tab}"`);
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
  it('shows a closed card on the cards tab by its id and status', () => {
    const plan = tabPlan('cards', USER);
    const [read] = plan.reads;
    const cardId = '3c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5';
    const html = renderToStaticMarkup(
      <CustomerRecord
        userId={USER}
        founderId={USER}
        tab="cards"
        reads={plan.reads}
        unwired={plan.unwired}
        outcomes={{
          [read!.id]: {
            id: read!.id,
            asOf: AS_OF,
            part: {
              kind: 'ok',
              data: {
                shape: 'list',
                pageFull: false,
                rows: [
                  {
                    id: cardId,
                    cells: [
                      { key: 'id', label: 'Card id', kind: 'text', detail: false, value: cardId },
                      { key: 'status', label: 'Status', kind: 'text', detail: false, value: 'closed', words: 'Closed' },
                    ],
                  },
                ],
              },
            },
          },
        }}
      />,
    );
    expect(html).toContain('data-testid="read-cards.list"');
    expect(html).toMatch(new RegExp(`<tr>.*${cardId}.*Closed.*</tr>`));
    expect(html).toContain('Card payments of this account: no source');
  });
  it('says why card payments and tickets cannot be read for one account, with the code', () => {
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
