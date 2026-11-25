// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { globalCopy } from '../../screens/pay/global-copy';
import { payCopy } from './copy';
import { createPayMutationGuard, createPersonalPayApi, type PersonalPayApi } from './pay-api';
import { MethodStatus, MethodsPages } from './personal/methods-parts';
import { MethodsRoom } from './personal/MethodsRoom';
import { orderHistoryCopy } from './personal/order-history-copy';
import { OrderHistory } from './personal/OrderHistory';
import { eligibilityCopy } from './personal/p2p-eligibility-copy';
import { myAdsCopy } from './personal/p2p-my-ads-copy';

const idleApi = createApiClient({ fetch: () => new Promise<Response>(() => {}) });
const basePay = (userId: string): PersonalPayApi => createPersonalPayApi(idleApi, userId, createPayMutationGuard());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function show(node: React.ReactNode) {
  if (!root) root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
  await act(async () => Promise.resolve());
}

describe('Pay & P2P customer copy (#6177)', () => {
  it('uses plain customer copy on /uc/order without ledger jargon or UTC-day date labels', async () => {
    const pay: PersonalPayApi = {
      ...basePay('b1'),
      todos: async () => ({ ok: true as const, data: [] }),
      orderPage: async () => ({
        ok: true as const,
        data: {
          trades: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              offerId: '22222222-2222-4222-8222-222222222222',
              sellerId: 's1',
              buyerId: 'b1',
              asset: 'USDT',
              amount: '25',
              fiatCurrency: 'EUR',
              fiatAmount: '23',
              price: '0.92',
              method: 'test-bank-transfer',
              status: 'released' as const,
              displayStatus: 'completed' as const,
              tab: 'completed' as const,
              resolution: 'released',
              deadlineAt: null,
              createdAt: '2026-10-17T10:00:00.000Z',
              escrowedAt: '2026-10-17T10:00:05.000Z',
              resolvedAt: '2026-10-17T10:15:00.000Z',
              settledAt: '2026-10-17T10:15:05.000Z',
              sharedFrom: false,
              releaseWindowSeconds: null,
              escrowKind: 'ledger' as const,
              contract: null,
            },
          ],
          counts: { in_progress: 0, in_dispute: 0, completed: 1, cancelled: 0 },
          nextCursor: null,
        },
      }),
      chatUnread: async (tradeId) => ({ ok: true as const, data: { tradeId, unread: 0 } }),
    };

    await show(<OrderHistory pay={pay} userId="b1" />);

    expect(host.textContent).not.toContain('Terminal status and ledger settlement time stay separate');
    expect(host.textContent).not.toContain('from the service');
    expect(host.textContent).not.toContain('made by the service');
    expect(host.textContent).not.toContain('UTC day');
    expect(host.textContent).not.toContain('Ledger settled');
    expect(host.textContent).toContain('Escrow settled');

    const inputs = [...host.querySelectorAll('form input')];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.getAttribute('type')).toBe('text');
      expect(input.getAttribute('pattern')).toBe('\\d{4}-\\d{2}-\\d{2}');
      expect(input.getAttribute('value')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(orderHistoryCopy.forLocale('en').t('exportFrom')).toBe('From');
    expect(orderHistoryCopy.forLocale('en').t('exportTo')).toBe('To');
    expect(payCopy.forLocale('en').t('externalPaymentLedgerEscrowAndARecorded')).not.toMatch(/ledger escrow|recorded order status/i);
  });

  it('structures /p2p/methods in panels and rows, gives enabled a done status, and hides below-limit counters', async () => {
    const pay: PersonalPayApi = {
      ...basePay('u1'),
      health: async () => ({
        ok: true as const,
        data: {
          ok: true,
          service: 'svc-p2p' as const,
          moderationConfigured: true,
          moderation: { status: 'configured' as const, code: 'p2p.moderation_unprobed' as const },
          offerLimitsConfigured: true,
          offerLimitsPosture: 'configured' as const,
          instrumentKmsConfigured: false,
          instrumentKeyProvider: 'local-test' as const,
        },
      }),
      methods: async () => ({
        ok: true as const,
        data: [
          {
            methodId: 'test-bank-transfer',
            country: 'DE',
            label: 'TEST bank transfer',
            enabled: true,
            settlement: { instant: true },
            kind: 'transfer' as const,
            noteRules: null,
            cashRules: null,
            fields: [{ key: 'account_holder', label: 'Account holder', required: true, holderName: true }],
          },
        ],
      }),
      fiat: async () => ({ ok: true as const, data: [{ code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2 }] }),
      instruments: async () => ({ ok: true as const, data: [] }),
    };

    await show(<MethodsRoom pay={pay} userId="u1" />);

    expect(host.textContent).not.toContain('External payment, ledger escrow');
    expect(host.textContent).not.toContain('Your payment destination labels');
    expect(host.textContent).toContain('Your payment methods');
    // Sections must be direct children of the settings region so SettingsTemplate styles each as its own panel.
    const sectionsRegion = host.querySelector('[data-region="sections"]');
    expect(sectionsRegion?.querySelector(':scope > section[id="p2p-methods-catalogue"]')).not.toBeNull();
    expect(sectionsRegion?.querySelector(':scope > section[id="p2p-methods-add"]')).not.toBeNull();
    expect(sectionsRegion?.querySelector(':scope > section[id="p2p-methods-saved"]')).not.toBeNull();
    // Catalogue uses structured .lt-rows list and .lt-title-row headers rather than bare unstyled articles.
    const catalogueList = host.querySelector('[data-testid="methods-catalogue"] ul.lt-rows');
    expect(catalogueList).not.toBeNull();
    expect(catalogueList?.querySelector('[data-testid="catalogue-method"] .lt-title-row')).not.toBeNull();
    const chip = catalogueList?.querySelector('.lt-chip');
    expect(chip?.getAttribute('data-status')).toBe('done');
    expect(chip?.textContent).toContain('enabled');

    // MethodStatus marks disabled as failed, and MethodsPages hides counters below the page limit.
    await show(
      <div>
        <MethodStatus value="disabled" />
        <MethodsPages count={3} limit={50} setLimit={() => {}} />
      </div>,
    );
    expect(host.querySelector('.lt-chip')?.getAttribute('data-status')).toBe('failed');
    expect(host.textContent).not.toContain('3 shown');
  });

  it('keeps /pay/global, /uc/ad and /p2p/access free of developer and service jargon across locales', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const g = globalCopy.forLocale(locale).t;
      expect(g('standIn')).toContain('TEST');
      expect(g('standIn')).not.toMatch(/TEST:\s*TEST|stand-in catalogue|local stack/i);
      expect(g('sentBody')).not.toMatch(/the service|el servicio|le service/i);
      expect(g('askedHint')).not.toMatch(/the service|el servicio|le service/i);

      const m = myAdsCopy.forLocale(locale).t;
      expect(m('editsUnset')).not.toMatch(/in this build|en esta versión|dans cette version/i);

      const e = eligibilityCopy.forLocale(locale).t;
      expect(e('intro')).not.toMatch(/the service|el servicio|le service/i);
      expect(e('reason_other')).not.toMatch(/the service|el servicio|le service/i);
    }
    expect(globalCopy.forLocale('en').t('standIn')).toContain('Nobody receives the money');
  });
});
