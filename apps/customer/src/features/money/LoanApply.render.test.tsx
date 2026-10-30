// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionSpec } from './components';

/**
 * The loan application (J-bank-09 #1 to #3): the product's limits with rate tiers not set, the bank's quote shown as it
 * came, each eligibility condition by name, the fee line or "not set", and a review that opens with the quoted figures.
 * A refused quote says why in words with its code as a reference, and an ineligible loan keeps its review button off.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const PRODUCT = '11111111-1111-4111-8111-111111111111';
type Read =
  { status: 'ready'; data: unknown } | { status: 'failed'; failure: { ok: false; reason: string; code?: string; message: string } };
let reads: Record<string, Read>;
let asked: Array<[string, unknown, boolean]>;
let reloaded: string[] = [];
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string, input: unknown, enabled = true) => {
      asked.push([procedure, input, enabled]);
      return { resource: (enabled && reads[procedure]) || { status: 'loading' }, reload: () => void reloaded.push(procedure) };
    },
  };
});
import { LoanApply } from './LoanApply';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
let opened: ActionSpec[] = [];

const product = {
  id: PRODUCT,
  name: 'TEST · BTC-backed USDT (local test, not a real rate)',
  debtAssetId: 'USDT',
  collateralAssetId: 'BTC',
  quoteAssetId: 'USDT',
  aprBps: 1000,
  maxLtvBps: 5000,
  marginCallLtvBps: 7500,
  liquidationLtvBps: 8500,
  minPrincipal: '0',
};
const quote = {
  productId: PRODUCT,
  debtAssetId: 'USDT',
  collateralAssetId: 'BTC',
  quoteAssetId: 'USDT',
  principal: '1000',
  requiredCollateral: '0.033333333333333334',
  startingLtvBps: 5000,
  maxLtvBps: 5000,
  liquidationLtvBps: 8500,
  liquidationPrice: '35294.11764705882282353',
  debtPrice: '1',
  collateralPrice: '60000',
  pricedAt: '2026-10-30T02:00:00.000Z',
};
const eligible = {
  productId: PRODUCT,
  eligible: true,
  reasons: [
    { key: 'lending_policy', state: 'met', code: null },
    { key: 'product_open', state: 'met', code: null },
    { key: 'assets_open', state: 'met', code: null },
    { key: 'origination_fee', state: 'met', code: null },
    { key: 'jurisdiction_rules', state: 'not_set', code: null },
  ],
};

beforeEach(() => {
  opened = [];
  asked = [];
  reloaded = [];
  reads = {
    'loans.products': { status: 'ready', data: [product] },
    'loans.quote': { status: 'ready', data: quote },
    'loans.eligibility': { status: 'ready', data: eligible },
    'loans.fees': { status: 'ready', data: { productId: PRODUCT, assetId: 'USDT', origination: { status: 'not_set' } } },
  };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<LoanApply productId={PRODUCT} open={(spec) => opened.push(spec)} />));
}

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const testId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

async function work(amount: string) {
  const input = host.querySelector<HTMLInputElement>('input[name="principal"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, amount);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Work it out').click());
}

describe('LoanApply', () => {
  it('shows the limits with rate tiers not set, and no quote or open before an amount is worked out', async () => {
    await mount();
    expect(testId('loan-apply-limits')?.textContent).toContain('10%');
    expect(testId('loan-apply-tiers')?.getAttribute('data-state')).toBe('not_set');
    expect(testId('loan-apply-tiers')?.textContent).toContain('Not set');
    expect(testId('loan-apply-quote')).toBeNull();
    expect(asked.some(([procedure, , enabled]) => procedure === 'loans.quote' && enabled)).toBe(false);
    expect(button('Review and open').disabled).toBe(true);
    expect(host.textContent).toContain('Work out the collateral first.');
  });

  it('works out the quote from the bank and opens with its figures under a fresh loan id', async () => {
    await mount();
    await work('1000');
    expect(asked).toContainEqual(['loans.quote', { productId: PRODUCT, principal: '1000' }, true]);
    expect(asked).toContainEqual(['loans.fees', { productId: PRODUCT, principal: '1000' }, true]);
    const shown = testId('loan-apply-quote')!;
    expect(shown.getAttribute('data-collateral')).toBe('0.033333333333333334');
    expect(shown.getAttribute('data-ltv-bps')).toBe('5000');
    expect(shown.getAttribute('data-liquidation-price')).toBe('35294.11764705882282353');
    expect(shown.textContent).toContain('35294.11764705882282353 USDT per BTC');
    await act(async () => button('Review and open').click());
    expect(opened).toHaveLength(1);
    const spec = opened[0]!;
    expect(spec.procedure).toBe('loans.open');
    expect(spec.initial).toEqual({ principal: '1000', collateralAmount: '0.033333333333333334' });
    expect(spec.input({ principal: '1000', collateralAmount: '0.033333333333333334' }, 'req-1')).toEqual({
      loanId: 'req-1',
      productId: PRODUCT,
      principal: '1000',
      collateralAmount: '0.033333333333333334',
      // The rate on the review: open refuses bank.loan_rate_changed if the product's rate moved since.
      expectedAprBps: 1000,
    });
  });

  it('names each eligibility condition, the jurisdiction rules as not set, and the fee table as not set', async () => {
    await mount();
    const list = testId('loan-apply-eligibility')!;
    expect(list.getAttribute('data-eligible')).toBe('true');
    expect(list.querySelector('[data-key="jurisdiction_rules"]')?.getAttribute('data-state')).toBe('not_set');
    expect(list.textContent).toContain('The bank has published no rules for where you live');
    expect(testId('loan-apply-fee')?.getAttribute('data-state')).toBe('not_set');
    expect(testId('loan-apply-fee')?.textContent).toContain('has not published its fee for opening a loan, so new loans are refused');
  });

  it('a policy that is off keeps review off and names the condition and its code', async () => {
    reads['loans.eligibility'] = {
      status: 'ready',
      data: {
        ...eligible,
        eligible: false,
        reasons: eligible.reasons.map((r) => (r.key === 'lending_policy' ? { ...r, state: 'unmet', code: 'bank.loans_disabled' } : r)),
      },
    };
    reads['loans.quote'] = {
      status: 'failed',
      failure: { ok: false, reason: 'precondition', code: 'bank.loans_disabled', message: 'Loans are disabled' },
    };
    await mount();
    const policy = testId('loan-apply-eligibility')!.querySelector('[data-key="lending_policy"]')!;
    expect(policy.getAttribute('data-state')).toBe('unmet');
    expect(policy.textContent).toContain('Reference: bank.loans_disabled');
    await work('1000');
    expect(host.querySelector('[role="alert"][data-code="bank.loans_disabled"]')?.textContent).toContain('Lending is closed');
    expect(button('Review and open').disabled).toBe(true);
  });

  it('a published fee shows its line, and a fee that cannot be collected is said to refuse new loans', async () => {
    reads['loans.fees'] = {
      status: 'ready',
      data: { productId: PRODUCT, assetId: 'USDT', origination: { status: 'published', bps: 50, amount: '5', collectable: false } },
    };
    await mount();
    const fee = testId('loan-apply-fee')!;
    expect(fee.getAttribute('data-state')).toBe('published');
    expect(fee.getAttribute('data-bps')).toBe('50');
    expect(fee.textContent).toContain('0.5%');
    expect(fee.textContent).toContain('new loans are refused');
  });

  it('names the fee line by the amount asked, not the asset alone, and shows no amount line before a quote', async () => {
    reads['loans.fees'] = {
      status: 'ready',
      data: { productId: PRODUCT, assetId: 'USDT', origination: { status: 'published', bps: 50, amount: '5', collectable: true } },
    };
    await mount();
    expect(testId('loan-apply-fee')!.textContent).not.toContain('Opening fee on');
    await work('1000');
    const line = testId('loan-apply-fee')!.textContent ?? '';
    expect(line).toMatch(/Opening fee on 1,?000(\.00)? USDT/);
    expect(line).not.toMatch(/Opening fee on USDT/);
  });

  it('asks the bank again when the same amount is worked out twice', async () => {
    await mount();
    await work('1000');
    expect(reloaded).toEqual([]);
    await work('1000');
    expect(reloaded).toEqual(['loans.quote', 'loans.fees']);
  });

  it('refuses a malformed amount in words without asking the bank', async () => {
    await mount();
    await work('12,5');
    expect(host.textContent).toContain('Enter an amount like 1000 or 12.5.');
    expect(asked.some(([procedure, , enabled]) => procedure === 'loans.quote' && enabled)).toBe(false);
  });
});
