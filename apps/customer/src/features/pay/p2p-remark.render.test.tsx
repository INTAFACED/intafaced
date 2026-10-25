// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentNoteRules, ReportRemark } from './p2p-remark';
import type { PersonalPayApi } from './pay-api';
import type { RemarkCase, Trade } from './schemas';

/** J-p2p-04 #5 (P-ads-merchant-19): the payer reads the payment-note rules; either party reports a sensitive remark. */

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

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const trade = (status: Trade['status'] = 'fiat_sent'): Trade => ({
  id: '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c',
  offerId: '33333333-3333-4333-8333-333333333333',
  sellerId: SELLER,
  buyerId: BUYER,
  asset: 'USDT',
  amount: '10',
  fiatCurrency: 'EUR',
  fiatAmount: '9.2',
  price: '0.92',
  method: 'test-bank-transfer',
  status,
  resolution: null,
  deadlineAt: null,
  createdAt: '2026-10-24T12:00:00.000Z',
  escrowedAt: '2026-10-24T12:00:01.000Z',
  resolvedAt: null,
  settledAt: null,
  mismatch: null,
});
const reported = (caseId: string): RemarkCase => ({
  id: caseId,
  tradeId: trade().id,
  reporterId: SELLER,
  reportedId: BUYER,
  reporterRole: 'seller',
  remark: 'USDT for order 12',
  status: 'open',
  openedAt: '2026-10-25T10:00:00.000Z',
});
const methodRow = (methodId: string, noteRules: { guidance: string; forbidden: string[] } | null) => ({
  methodId,
  country: 'DE',
  label: 'TEST bank transfer',
  fields: [],
  enabled: true,
  settlement: null,
  noteRules,
  cashRules: null,
});

async function render(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
  return host;
}
const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Report the remark')!;
async function type(value: string) {
  const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Report a sensitive payment-note remark (J-p2p-04 #5)', () => {
  it('stays off until a remark is quoted, then sends it trimmed and shows the open case', async () => {
    const reportSensitiveRemark = vi.fn(async (_trade: string, caseId: string) => ({ ok: true as const, data: reported(caseId) }));
    await render(<ReportRemark trade={trade()} pay={{ reportSensitiveRemark } as unknown as PersonalPayApi} />);
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('Quote the remark from the payment note.');
    await type('  USDT for order 12  ');
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(reportSensitiveRemark).toHaveBeenCalledWith(trade().id, expect.stringMatching(/^[0-9a-f-]{36}$/), 'USDT for order 12');
    const result = host.querySelector('[data-testid="order-remark-case"]')!;
    expect(result.textContent).toContain('A case is open for staff to decide.');
    expect(result.getAttribute('data-case-id')).toBe(reportSensitiveRemark.mock.calls[0]![1]);
  });

  it('a resend of the same quote is the same case id; a changed quote is a new one', async () => {
    const reportSensitiveRemark = vi.fn(async () => ({
      ok: false as const,
      reason: 'uncertain' as const,
      message: 'Connection ended',
      status: 503,
    }));
    await render(<ReportRemark trade={trade()} pay={{ reportSensitiveRemark } as unknown as PersonalPayApi} />);
    await type('USDT');
    await act(async () => button().click());
    await act(async () => button().click());
    await type('USDT please');
    await act(async () => button().click());
    const ids = reportSensitiveRemark.mock.calls.map((call) => (call as unknown[])[1]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('stays off past 280 characters, and says a repeat report and a refused quote in its own words', async () => {
    const reportSensitiveRemark = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'error', message: 'service text', code: 'p2p.remark_case_exists', status: 409 })
      .mockResolvedValueOnce({ ok: false, reason: 'error', message: 'service text', code: 'p2p.remark_invalid', status: 400 });
    await render(<ReportRemark trade={trade()} pay={{ reportSensitiveRemark } as unknown as PersonalPayApi} />);
    await type('x'.repeat(281));
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('Quote at most 280 characters.');
    await type('USDT');
    await act(async () => button().click());
    expect(host.textContent).toContain('You already reported a remark on this order.');
    await act(async () => button().click());
    expect(host.textContent).toContain('Quote the remark in 1 to 280 characters.');
    expect(host.textContent).not.toContain('service text');
  });

  it('is not offered before the order is funded', async () => {
    await render(<ReportRemark trade={trade('created')} pay={{} as PersonalPayApi} />);
    expect(host.querySelector('[data-testid="order-remark-report"]')).toBeNull();
  });
});

describe('Payment-note rules on the order (P-ads-merchant-19)', () => {
  it('shows the buyer of a funded order the method’s guidance and the words never to write', async () => {
    const methods = vi.fn(async () => ({
      ok: true as const,
      data: [
        methodRow('other', null),
        methodRow('test-bank-transfer', { guidance: 'TEST: the order number only.', forbidden: ['USDT', 'P2P'] }),
      ],
    }));
    await render(<PaymentNoteRules trade={trade('escrowed')} pay={{ methods } as unknown as PersonalPayApi} userId={BUYER} />);
    const rules = host.querySelector('[data-testid="order-note-rules"]')!;
    expect(rules.textContent).toContain('TEST: the order number only.');
    expect(host.querySelector('[data-testid="order-note-forbidden"]')!.textContent).toContain('Never write: USDT, P2P');
  });

  it('shows nothing to the seller, after payment, for a method without rules, or when the catalogue cannot be read', async () => {
    const methods = vi.fn(async () => ({ ok: true as const, data: [methodRow('test-bank-transfer', null)] }));
    await render(<PaymentNoteRules trade={trade('escrowed')} pay={{ methods } as unknown as PersonalPayApi} userId={SELLER} />);
    expect(methods).not.toHaveBeenCalled();
    act(() => root?.unmount());
    await render(<PaymentNoteRules trade={trade('fiat_sent')} pay={{ methods } as unknown as PersonalPayApi} userId={BUYER} />);
    expect(methods).not.toHaveBeenCalled();
    act(() => root?.unmount());
    await render(<PaymentNoteRules trade={trade('escrowed')} pay={{ methods } as unknown as PersonalPayApi} userId={BUYER} />);
    expect(host.querySelector('[data-testid="order-note-rules"]')).toBeNull();
    act(() => root?.unmount());
    const failing = vi.fn(async () => ({ ok: false as const, reason: 'error' as const, message: 'down', status: 503 }));
    await render(<PaymentNoteRules trade={trade('escrowed')} pay={{ methods: failing } as unknown as PersonalPayApi} userId={BUYER} />);
    expect(host.querySelector('[data-testid="order-note-rules"]')).toBeNull();
  });
});
