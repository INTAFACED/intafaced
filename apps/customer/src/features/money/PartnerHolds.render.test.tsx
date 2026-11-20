// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { partnerHoldsSchema, type PartnerHolds } from './contracts';
import { HeldView } from './PartnerHolds';

/**
 * J-wallet-01 #3 on the screen: Withdraw shows what the partner holds back of a purchase with its release time, what can
 * be withdrawn now, a partner that does not report its holds in those words (never 0), and each release once.
 */
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const held = (data: unknown) => {
  const parsed = partnerHoldsSchema.parse(data);
  if (!parsed.held) throw new Error('a held view needs a held person');
  return parsed as Extract<PartnerHolds, { held: true }>;
};
const render = (data: Extract<PartnerHolds, { held: true }>) => act(() => root.render(<HeldView data={data} />));
const HOLD = { id: 'h1', assetId: 'USDT', amount: '20', paidBy: 'bank_pull', releaseAt: '2026-11-14T10:00:00.000Z' };

describe('what the partner holds back, on Withdraw', () => {
  it('names the hold with its release time and withdraws only the rest', () => {
    render(
      held({
        held: true,
        label: 'TEST partner bank',
        reported: true,
        asOf: '2026-11-11T10:00:00.000Z',
        balances: [{ assetId: 'USDT', balance: '70', balanceAsOf: '2026-11-11T10:00:00.000Z', heldBack: '20', withdrawable: '50' }],
        holds: [HOLD],
        released: [],
      }),
    );
    const row = host.querySelector('[data-testid="partner-withdrawable"]')!;
    expect(row.querySelector('[data-cell="held-back"]')!.textContent).toContain('20');
    expect(row.querySelector('[data-cell="withdrawable"]')!.textContent).toContain('50');
    const hold = host.querySelector('[data-testid="partner-hold"]')!;
    expect(hold.getAttribute('data-release-at')).toBe(HOLD.releaseAt);
    expect(hold.textContent).toMatch(/^TEST partner bank's hold: .*20.* from a bank pull purchase, released /);
    expect(host.querySelector('[data-testid="partner-release"]')).toBeNull();
  });

  it('says "not reported by the partner" when the partner does not report its holds, never 0', () => {
    render(
      held({
        held: true,
        label: 'TEST partner bank',
        reported: false,
        asOf: null,
        balances: [{ assetId: 'USDT', balance: '70', balanceAsOf: null, heldBack: null, withdrawable: null }],
        holds: [],
        released: [],
      }),
    );
    const row = host.querySelector('[data-testid="partner-withdrawable"]')!;
    expect(row.querySelector('[data-cell="held-back"]')!.textContent).toBe('not reported by the partner');
    expect(row.querySelector('[data-cell="withdrawable"]')!.textContent).toBe('not reported by the partner');
    expect(host.textContent).not.toContain('holds nothing back');
  });

  it('lists a release once, with when the partner released it', () => {
    render(
      held({
        held: true,
        label: 'TEST partner bank',
        reported: true,
        asOf: '2026-11-11T10:00:00.000Z',
        balances: [{ assetId: 'USDT', balance: '70', balanceAsOf: '2026-11-11T10:00:00.000Z', heldBack: '0', withdrawable: '70' }],
        holds: [],
        released: [{ ...HOLD, releasedAt: '2026-11-11T10:00:00.000Z' }],
      }),
    );
    const released = host.querySelectorAll('[data-testid="partner-release"]');
    expect(released).toHaveLength(1);
    expect(released[0]!.textContent).toMatch(/^Released by TEST partner bank: .*20.* from a bank pull purchase, at /);
    expect(host.querySelector('[data-testid="partner-hold"]')).toBeNull();
  });
});
