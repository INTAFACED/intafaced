// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalPayApi } from '../pay-api';
import type { Offer, PostOfferInput } from '../schemas';
import { AdvertiserTermsSheet, LevelLimits, OfferReceipt, OfferSummary, PostingChecklist, postInput } from './p2p-post';
import { emptyOffer } from './p2p-model';

/**
 * J-p2p-03 #1, #2, #4, #6 (P-ads-merchant-01, -02, -12): the posting checklist, the summary, the advertiser terms, the
 * level's per-order limits and the receipt of a posted ad.
 */

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
  document.body.innerHTML = '';
});

async function render(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
  return document.body;
}
const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent === name)!;

const input: PostOfferInput = {
  side: 'sell',
  asset: 'USDT',
  fiatCurrency: 'EUR',
  priceType: 'fixed',
  price: '0.93',
  minAmount: '10',
  maxAmount: '100',
  totalAmount: '500',
  methods: ['test-bank-transfer'],
  terms: 'TEST terms: own-name accounts only.',
};

describe('OfferSummary', () => {
  it('lists every field, the frozen-terms note and the terms state, and posts on confirm', async () => {
    const onConfirm = vi.fn();
    const page = await render(
      <OfferSummary
        input={input}
        methodLabels={['TEST bank transfer']}
        termsNote="You accepted advertiser terms TEST-1."
        failure={null}
        posting={false}
        onConfirm={onConfirm}
        onBack={() => {}}
      />,
    );
    const summary = page.querySelector('[data-testid="offer-summary"]')!;
    for (const text of ['Sell USDT for EUR', '0.93 EUR', '10 to 100 USDT', '500 USDT', 'TEST bank transfer', 'own-name accounts only'])
      expect(summary.textContent).toContain(text);
    expect(summary.textContent).toContain('Orders keep the terms they were placed on');
    expect(summary.textContent).toContain('You accepted advertiser terms TEST-1.');
    await act(async () => button('Post ad').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('says a total above the free balance in figures, and an unset owner value in words', async () => {
    const page = await render(
      <OfferSummary
        input={input}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{
          ok: false,
          reason: 'error',
          message: 'short',
          code: 'p2p.insufficient_balance',
          p2pLimit: { until: null, available: '400', shortBy: '100' },
        }}
        posting={false}
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
    expect(page.textContent).toContain('400 USDT is free, 100 USDT short');
    act(() => root?.unmount());
    root = null;
    const again = await render(
      <OfferSummary
        input={{ ...input, totalAmount: undefined, terms: undefined }}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{ ok: false, reason: 'error', message: 'unset', code: 'p2p.config_unset' }}
        posting
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
    expect(again.textContent).toContain('not published by the operator');
    expect(again.textContent).toContain('Same as the maximum per order');
    expect(again.textContent).toContain('None');
    expect(button('Posting…').disabled).toBe(true);
  });

  it('names the switched-off key service, and a key that already posted another ad', async () => {
    const summary = (code: string) => (
      <OfferSummary
        input={input}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{ ok: false, reason: 'error', message: code, code }}
        posting={false}
        onConfirm={() => {}}
        onBack={() => {}}
      />
    );
    const page = await render(summary('p2p.instrument_kms_required'));
    expect(page.textContent).toContain('Posting an ad needs a key service for payment details. It is switched off in this build');
    act(() => root?.unmount());
    root = null;
    expect((await render(summary('p2p.idempotency_conflict'))).textContent).toContain('This form already sent an ad');
    act(() => root?.unmount());
    root = null;
    expect((await render(summary('p2p.content_rule_violation'))).textContent).toContain('Your terms include something an ad may not carry');
    act(() => root?.unmount());
    root = null;
    const classed = await render(
      <OfferSummary
        input={input}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{
          ok: false,
          reason: 'error',
          message: 'x',
          code: 'p2p.content_rule_violation',
          p2pLimit: { until: null, ruleClass: 'outside_link' },
        }}
        posting={false}
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
    expect(classed.textContent).toContain('Your terms break the content rule “outside link”.');
  });
});

describe('LevelLimits and a buy ad beyond them', () => {
  it('shows the band for the level and which side it binds, and says an unpublished table plainly', async () => {
    const levelLimits = vi.fn(async () => ({
      ok: true as const,
      data: { tier: 'basic' as const, currency: 'EUR', orderMin: '0.5', orderMax: '500' },
    }));
    const page = await render(<LevelLimits pay={{ levelLimits } as unknown as PersonalPayApi} side="buy" />);
    const limits = page.querySelector('[data-testid="offer-level-limits"]')!;
    expect(limits.textContent).toContain('Per order at your level (basic): 0.5 to 500 EUR.');
    expect(limits.textContent).toContain('you are the buyer in each one');
    act(() => root?.unmount());
    root = null;
    const unset = vi.fn(async () => ({
      ok: false as const,
      reason: 'error' as const,
      message: 'unset',
      code: 'p2p.verification_limits_unset',
    }));
    const blank = await render(<LevelLimits pay={{ levelLimits: unset } as unknown as PersonalPayApi} side="sell" />);
    expect(blank.textContent).toContain('has not published per-order limits by level');
  });

  it('says a buy ad beyond the level with the band to fit', async () => {
    const page = await render(
      <OfferSummary
        input={{ ...input, side: 'buy', maxAmount: '600' }}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{
          ok: false,
          reason: 'error',
          message: 'over',
          code: 'p2p.verification_order_max',
          p2pLimit: { until: null, min: '0.5', max: '500', currency: 'EUR' },
        }}
        posting={false}
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
    expect(page.textContent).toContain('Each order on this buy ad must be between 0.5 and 500 EUR at your level');
  });
});

describe('PostingChecklist', () => {
  it('asks for a fiat first, then lists each check with your value and the target', async () => {
    const postingEligibility = vi.fn(async () => ({
      ok: true as const,
      data: {
        fiatCurrency: 'EUR',
        policy: 'thresholds' as const,
        checks: [
          { id: 'kyc_tier' as const, state: 'met' as const, current: 'full', required: 'basic', reason: 'posting.met' },
          {
            id: 'completed_orders' as const,
            state: 'not_met' as const,
            current: '2',
            required: '5',
            reason: 'p2p.posting_threshold_not_met',
          },
          { id: 'completion_rate' as const, state: 'unknown' as const, current: null, required: '90', reason: 'p2p.completion_rate_none' },
        ],
      },
    }));
    const pay = { postingEligibility } as unknown as PersonalPayApi;
    const blank = await render(<PostingChecklist pay={pay} fiatCurrency="" />);
    expect(blank.querySelector('[data-testid="posting-checklist"]')!.textContent).toContain('Pick a fiat currency');
    expect(postingEligibility).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;
    const page = await render(<PostingChecklist pay={pay} fiatCurrency="EUR" />);
    expect(postingEligibility).toHaveBeenCalledWith('EUR', expect.anything());
    const list = page.querySelector('[data-testid="posting-checklist"]')!;
    expect(list.textContent).toContain('What posting an ad in EUR needs');
    expect(list.querySelector('[data-check="kyc_tier"]')!.textContent).toContain('Met. You: full. Needed: basic.');
    expect(list.querySelector('[data-check="completed_orders"]')!.textContent).toContain('You: 2. Needed: 5.');
    expect(list.querySelector('[data-check="completion_rate"]')!.textContent).toContain(
      'Cannot be checked. You: not available. Needed: 90%.',
    );
  });

  it('says a fiat with nothing published, and a fiat with no threshold, plainly', async () => {
    const answer = (policy: 'unset' | 'none') =>
      ({
        postingEligibility: vi.fn(async () => ({ ok: true as const, data: { fiatCurrency: 'GBP', policy, checks: [] } })),
      }) as unknown as PersonalPayApi;
    expect((await render(<PostingChecklist pay={answer('unset')} fiatCurrency="GBP" />)).textContent).toContain(
      'has not published posting requirements for GBP, so ads in GBP are refused',
    );
    act(() => root?.unmount());
    root = null;
    expect((await render(<PostingChecklist pay={answer('none')} fiatCurrency="GBP" />)).textContent).toContain(
      'There is no posting threshold for GBP',
    );
  });

  it('says a post below a threshold, and a floating price with no market price, in the room’s words', async () => {
    const page = await render(
      <OfferSummary
        input={input}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{ ok: false, reason: 'error', message: 'x', code: 'p2p.posting_threshold_not_met' }}
        posting={false}
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
    expect(page.textContent).toContain('Your account does not meet what posting an ad in this currency needs. Go back to the form');
    act(() => root?.unmount());
    root = null;
    const floating = await render(
      <OfferSummary
        input={{ ...input, priceType: 'float', price: '1.02' }}
        methodLabels={['TEST bank transfer']}
        termsNote={null}
        failure={{ ok: false, reason: 'error', message: 'x', code: 'p2p.reference_price_unavailable' }}
        posting={false}
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
    expect(floating.textContent).toContain('No market price is published for this coin and currency');
  });
});

describe('AdvertiserTermsSheet', () => {
  it('shows the version and its points, and accepts exactly that version', async () => {
    const acceptAdvertiserTerms = vi.fn(async (version: string) => ({
      ok: true as const,
      data: { version, acceptedAt: '2026-10-24T17:00:00.000Z' },
    }));
    const onAccepted = vi.fn();
    const page = await render(
      <AdvertiserTermsSheet
        pay={{ acceptAdvertiserTerms } as unknown as PersonalPayApi}
        version="TEST-2026-10-24"
        onAccepted={onAccepted}
        onClose={() => {}}
      />,
    );
    const sheet = page.querySelector('[data-testid="advertiser-terms"]')!;
    expect(sheet.textContent).toContain('Terms TEST-2026-10-24');
    expect(sheet.textContent).toContain('Release only after the money is in your own account');
    await act(async () => button('I accept these terms').click());
    expect(acceptAdvertiserTerms).toHaveBeenCalledWith('TEST-2026-10-24');
    expect(onAccepted).toHaveBeenCalledWith('TEST-2026-10-24');
  });

  it('says so when the acceptance was not recorded', async () => {
    const acceptAdvertiserTerms = vi.fn(async () => ({ ok: false as const, reason: 'unreachable' as const, message: 'down' }));
    const onAccepted = vi.fn();
    const page = await render(
      <AdvertiserTermsSheet
        pay={{ acceptAdvertiserTerms } as unknown as PersonalPayApi}
        version="TEST-1"
        onAccepted={onAccepted}
        onClose={() => {}}
      />,
    );
    await act(async () => button('I accept these terms').click());
    expect(onAccepted).not.toHaveBeenCalled();
    expect(page.textContent).toContain('The acceptance was not recorded');
  });
});

describe('OfferReceipt', () => {
  it('shows the ad id and Listed for an active ad', async () => {
    const offer = { id: 'a0000000-0000-4000-8000-000000000001', asset: 'USDT', status: 'active' } as Offer;
    const page = await render(<OfferReceipt offer={offer} onAnother={() => {}} />);
    const receipt = page.querySelector('[data-testid="offer-receipt"]')!;
    expect(receipt.textContent).toContain(offer.id);
    expect(receipt.textContent).toContain('Listed');
    expect(receipt.querySelector('a[href="/uc/ad"]')).not.toBeNull();
  });
});

describe('postInput', () => {
  it('trims, puts the coin in capitals and leaves blank optional fields out', () => {
    const values = {
      ...emptyOffer(),
      asset: ' usdt ',
      fiatCurrency: 'EUR',
      price: ' 0.93',
      minAmount: '10 ',
      maxAmount: '100',
      totalAmount: '  ',
      methods: ['test-bank-transfer'],
      terms: '   ',
      acceptsNonInstant: true,
    };
    expect(postInput({ ...values, side: 'sell' })).toEqual({
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: '0.93',
      minAmount: '10',
      maxAmount: '100',
      methods: ['test-bank-transfer'],
      acceptsNonInstant: true,
    });
    // A buy ad carries no non-instant consent: it is the seller's to give.
    expect(postInput({ ...values, side: 'buy' })).not.toHaveProperty('acceptsNonInstant');
  });
});
