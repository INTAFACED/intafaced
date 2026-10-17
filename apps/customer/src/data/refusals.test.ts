import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyRefusal } from './refusal-codes';
import { refusalCopy } from './refusals';

describe('refusalCopy: the spec table (UI-SPEC §4.3)', () => {
  it('screening refusals', () => {
    for (const code of ['denied.screening_fixture', 'denied.screening_unconfigured', 'denied.network_dark', 'denied.module_blocked']) {
      expect(refusalCopy(code)).toEqual({
        title: 'Paused for account checks',
        body: 'Your account is paused while checks are set up.',
        reference: 'Ref SCR-1',
      });
    }
  });
  it('verification refusals point to /verification', () => {
    for (const code of ['kyc.tier_required', 'denied.kyc_required', 'tier.insufficient', 'kyc.anything', 'trade.tier_required']) {
      expect(refusalCopy(code)).toEqual({
        title: 'Verify your identity first',
        body: 'You need a verified account to do this.',
        action: { label: 'Verify now', href: '/verification' },
        reference: 'Ref VER-1',
      });
    }
  });
  it('prices that cannot load and a missing second factor have their own words', () => {
    expect(refusalCopy('bank.prices_unavailable')).toMatchObject({ body: "Prices can't be loaded right now. Try again in a minute." });
    expect(refusalCopy('auth.mfa_required')).toMatchObject({
      body: 'Sign in again with your passkey or authenticator code to change this.',
    });
  });
  it('shows a short reference, never the raw code', () => {
    expect(refusalCopy('denied.screening_fixture').reference).toBe('Ref SCR-1');
    expect(refusalCopy('something.never_seen').reference).toBeUndefined();
    for (const code of ['denied.screening_fixture', 'bank.prices_unavailable', 'denied.region_blocked'])
      expect(refusalCopy(code).reference ?? '').not.toContain(code);
  });
  it('instant buy paused links to Spot for the pair', () => {
    expect(refusalCopy('trade.convert_spread_unset', { pair: 'BTC-USDT' })).toEqual({
      title: 'Instant buy is paused',
      body: "Prices for instant buys aren't set up yet.",
      action: { label: 'Use Spot', href: '/trade/spot/BTC-USDT' },
    });
    expect(refusalCopy('trade.convert_spread_unset').action?.href).toBe('/trade');
  });
  it('operator-not-configured refusals read as "not set up yet", never as the raw code', () => {
    for (const code of ['token.params_invalid', 'token.params_missing', 'token.proposal_list_limit_unset'])
      expect(refusalCopy(code)).toEqual({
        title: 'Not set up yet',
        body: 'This part of INTAFACED has not been switched on yet. Nothing was changed.',
      });
  });
  it('market orders paused', () => {
    expect(refusalCopy('trade.slippage_cap_unset')).toEqual({ title: 'Market orders are paused', body: 'Use a limit order instead.' });
  });
  it('no book', () => {
    expect(refusalCopy('trade.no_book').title).toBe('No one is trading this market right now');
    expect(refusalCopy('trade.no_book').body).toBe('Prices will show when the first orders arrive.');
  });
  it('market not open', () => {
    for (const code of [
      'trade.lifecycle_authority_unavailable',
      'trade.market_closed',
      'trade.market_halted',
      'edge.venue_halted',
      'trade.venue_halted',
    ]) {
      expect(refusalCopy(code)).toEqual({ title: "This market isn't open", body: "You can't trade it right now." });
    }
  });
  it('insufficient balance fills the blanks, and stays honest without them', () => {
    expect(refusalCopy('ledger.insufficient_funds', { asset: 'USDT', available: '15.11' })).toEqual({
      title: 'Not enough USDT',
      body: 'You have 15.11 USDT available.',
    });
    expect(refusalCopy('trade.hold_uncovered').title).toBe('Not enough funds');
    expect(refusalCopy('trade.hold_uncovered').body).not.toMatch(/[{}]/);
  });
  it('recipient cases', () => {
    expect(refusalCopy('bank.dest_user_missing')).toEqual({
      title: "We couldn't find that account",
      body: 'Check the handle and try again.',
    });
    expect(refusalCopy('bank.dest_user_missing', { recipient: '@sam', asset: 'USDT' })).toEqual({
      title: "@sam can't receive USDT yet",
      body: 'Ask them to open INTAFACED once, then try again.',
    });
  });
  it('anything else uses the last row, with support only when Help is live', () => {
    expect(refusalCopy('something.never_seen')).toEqual({
      title: "This can't be done right now",
      body: 'Try again later. If it keeps happening, contact support.',
    });
    expect(refusalCopy('', {}).title).toBe("This can't be done right now");
    expect(refusalCopy('something.never_seen', { helpHref: '/help' }).action).toEqual({ label: 'Contact support', href: '/help' });
  });
});

describe('classifyRefusal', () => {
  it('sorts the codes customers can reach', () => {
    const cases: Array<[string, string]> = [
      ['denied.region_blocked', 'region'],
      ['denied.region_unknown', 'region'],
      ['edge.rate_limited', 'rateLimited'],
      ['edge.gateway', 'tryAgain'],
      ['edge.no_route', 'tryAgain'],
      ['trade.matching_unavailable', 'tryAgain'],
      ['trade.order_not_found', 'orderGone'],
      ['trade.convert_price_moved', 'priceMoved'],
      ['trade.convert_quote_expired', 'quoteExpired'],
      ['ledger.frozen', 'accountOnHold'],
      ['mfa.required', 'stepUp'],
      ['auth.mfa_required', 'mfaRequired'],
      ['bank.prices_unavailable', 'pricesDown'],
      ['auth.required', 'signedOut'],
      ['bank.below_minimum', 'belowMinimum'],
      ['trade.self_trade', 'selfTrade'],
      ['trade.convert_insufficient_depth', 'insufficientDepth'],
      ['trade.convert_invalid_qty', 'quoteFailed'],
    ];
    for (const [code, kind] of cases) expect(classifyRefusal(code), code).toBe(kind);
  });
  it('is case-insensitive and tolerant of blanks', () => {
    expect(classifyRefusal('  KYC.TIER_REQUIRED ')).toBe('verify');
    expect(classifyRefusal(null)).toBe('unknown');
    expect(classifyRefusal(undefined)).toBe('unknown');
  });
});

describe('spend-sized convert refusals', () => {
  it('says plainly when the book cannot absorb the spend, and shows no raw code', () => {
    const copy = refusalCopy('trade.convert_insufficient_depth');
    expect(copy.body).toBe('Not enough for sale right now for that amount. Try a smaller amount.');
    expect(`${copy.title} ${copy.body}`).not.toMatch(/trade\.|convert_|quoteQty/);
  });
  it('treats a bad size as our mistake with a generic try-again', () => {
    expect(refusalCopy('trade.convert_invalid_qty')).toEqual({ title: "Couldn't get a price", body: "Couldn't get a price, try again." });
  });
});

describe('customer words', () => {
  it('no banned word appears in refusals.ts (checked as the E2E run does)', () => {
    const source = readFileSync(new URL('./refusals.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/unavailable|not connected|restricted|fixture|lifecycle/i);
  });
  it('no banned word reaches a customer through any message', () => {
    const codes = [
      'denied.screening_fixture',
      'trade.lifecycle_authority_unavailable',
      'ledger.frozen',
      'trade.account_restricted',
      'trade.no_book',
      'x.y',
      'edge.no_route',
    ];
    for (const code of codes) {
      const copy = refusalCopy(code, { asset: 'BTC', available: '1', recipient: '@a', pair: 'BTC-USDT' });
      expect(`${copy.title} ${copy.body} ${copy.action?.label ?? ''}`).not.toMatch(
        /unavailable|not connected|restricted|fixture|lifecycle/i,
      );
    }
  });
});
