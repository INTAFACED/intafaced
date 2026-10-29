import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiClient } from '../shared/api';
import { classifyRefusal } from './refusal-codes';
import { refusalCopy } from './refusals';

describe('the platform posting freeze on the trade API (DV-errors-02)', () => {
  it('a REST refusal with intafacedCode posting_frozen gets the same on-hold copy as ledger.frozen', async () => {
    const api = createApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ code: 'ExchangeError', message: 'Ledger posting is frozen: TEST freeze', intafacedCode: 'posting_frozen' }),
          { status: 400 },
        ),
    });
    const result = await api.rest('/orders', z.unknown(), { method: 'POST', body: { symbol: 'BTC/USDT' } });
    expect(result).toMatchObject({ ok: false, code: 'posting_frozen' });
    const code = result.ok ? '' : (result.code ?? '');
    expect(classifyRefusal(code)).toBe('accountOnHold');
    expect(refusalCopy(code)).toEqual(refusalCopy('ledger.frozen'));
    expect(refusalCopy(code).title).toBe('Your account is on hold');
  });
});

describe('edge.authority_unavailable', () => {
  it('is a retry, not a sign-out', () => {
    expect(classifyRefusal('edge.authority_unavailable')).toBe('tryAgain');
  });
});

describe('fee refusals (SP-fees-vip-01)', () => {
  it('a blank schedule for the market names the fee schedule, before any hold', () => {
    expect(classifyRefusal('trade.fee_schedule_blank')).toBe('feeScheduleUnset');
    expect(refusalCopy('trade.fee_schedule_blank').title).toBe('Fee schedule not set');
    expect(refusalCopy('trade.fee_schedule_blank').body).toContain('Nothing was held');
  });

  it('a missing product schedule, rebate recipe or minimum-fee recipe reads as not switched on', () => {
    for (const code of ['trade.fee_product_unpublished', 'trade.rebate_recipe_unavailable', 'trade.min_fee_recipe_unavailable']) {
      expect(classifyRefusal(code)).toBe('notSetUp');
    }
  });

  it('maps the order tag, expiry and fee-currency refusals to their own copy', () => {
    expect(classifyRefusal('trade.invalid_tag')).toBe('tagInvalid');
    expect(classifyRefusal('trade.invalid_expiry')).toBe('expiryInvalid');
    expect(classifyRefusal('trade.fee_currency_unsupported')).toBe('optionUnsupported');
  });
});

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
      body: "Prices for instant buys aren't set up.",
      action: { label: 'Use Spot', href: '/trade/spot/BTC-USDT' },
    });
    expect(refusalCopy('trade.convert_spread_unset').action?.href).toBe('/trade');
  });
  it('operator-not-configured refusals read as "not switched on", never as the raw code', () => {
    for (const code of ['token.params_invalid', 'token.params_missing', 'token.proposal_list_limit_unset'])
      expect(refusalCopy(code)).toEqual({
        title: 'Not switched on',
        body: "This part of INTAFACED isn't switched on. Nothing was changed.",
      });
  });
  it('the bank activity and address book refusals have their own words, and "not set" codes read as not switched on', () => {
    expect(refusalCopy('bank.destination_label_taken')).toMatchObject({ title: 'That name is taken' });
    expect(refusalCopy('bank.address_book_full')).toMatchObject({ title: 'Your address book is full' });
    expect(refusalCopy('bank.activity_sort_bounded')).toMatchObject({ title: 'Too many lines to sort oldest first' });
    expect(refusalCopy('portfolio.entries_do_not_sum')).toMatchObject({ title: 'The entries do not add up to your balance' });
    expect(refusalCopy('bank.activity_lookup_bounded')).toMatchObject({ title: 'Too many entries to check at once' });
    expect(refusalCopy('bank.activity_account_unknown')).toMatchObject({ title: "We couldn't find that" });
    for (const code of [
      'bank.fx_rate_unset',
      'portfolio.tax_effect_map_unset',
      'portfolio.tax_year_start_unset',
      'bank.address_book_cap_unset',
    ])
      expect(refusalCopy(code)).toMatchObject({ title: 'Not switched on' });
  });
  it('market orders paused', () => {
    expect(refusalCopy('trade.slippage_cap_unset')).toEqual({ title: 'Market orders are paused', body: 'Use a limit order instead.' });
  });
  it('price protection not set', () => {
    expect(refusalCopy('trade.protection_unset').title).toBe('Price protection isn’t set');
    expect(refusalCopy('trade.protection_unset').body).toContain('Use a limit order instead.');
  });
  it('a band or open-order cap the market has not published: named, never defaulted', () => {
    expect(refusalCopy('trade.price_band_unset')).toEqual({
      title: 'No price band is published',
      body: 'This market takes no priced orders until it publishes the range of prices it accepts. Nothing was sent.',
    });
    expect(refusalCopy('trade.open_orders_cap_unset').title).toBe('No open-order limit is published');
  });
  it('price band: the edges when the screen has them, the rule in words when it does not', () => {
    expect(refusalCopy('trade.price_band', { low: '90.00', high: '110.00' })).toEqual({
      title: 'Price is outside the allowed range',
      body: 'This market takes buy prices up to 110.00 and sell prices down to 90.00 right now. Change the price and try again.',
    });
    expect(refusalCopy('trade.price_band').body).toContain('near the middle of its book');
  });
  it('open-order cap: the cap and the count', () => {
    expect(refusalCopy('trade.operator_throttle', { cap: '20', open: '20' }).body).toBe(
      'You have 20 open orders here and this market allows 20. Cancel one to place another.',
    );
    expect(refusalCopy('trade.limit_max_open_orders').title).toBe('Too many open orders');
  });
  it('no book', () => {
    expect(refusalCopy('trade.no_book').title).toBe('No one is trading this market right now');
    expect(refusalCopy('trade.no_book').body).toBe('Prices will show when the first orders arrive.');
  });
  it('market not open', () => {
    for (const code of ['trade.lifecycle_authority_unavailable', 'trade.market_closed']) {
      expect(refusalCopy(code)).toEqual({ title: "This market isn't open", body: "You can't trade it right now." });
    }
  });
  it('an operator halt says halted, and that open orders can still be cancelled', () => {
    for (const code of ['trade.market_halted', 'edge.venue_halted', 'trade.venue_halted']) {
      expect(refusalCopy(code)).toEqual({
        title: 'Trading is halted',
        body: 'An operator has paused new orders. Your open orders stay, and you can still cancel them.',
      });
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
      title: "@sam can't receive USDT",
      body: 'Ask them to open INTAFACED once, then try again.',
    });
  });
  it('a chart window past the published point cap asks for a shorter range', () => {
    expect(classifyRefusal('trade.candles_range_point_cap')).toBe('chartRange');
    expect(refusalCopy('trade.candles_range_point_cap')).toEqual({
      title: 'That chart range is too long',
      body: 'Choose a shorter range and try again.',
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

describe('order refusals the pro desk shows by their registered words (TRD-0521)', () => {
  it('names a post-only, fill-or-kill, unsupported-type and minimum-notional refusal, and never the raw code', () => {
    expect(refusalCopy('trade.post_only_would_cross')).toEqual({
      title: 'Post-only order not placed',
      body: 'It would have matched an order on the book right away, so it was refused. Nothing was traded.',
    });
    expect(refusalCopy('fok_unfillable').title).toBe('Fill-or-kill order not placed');
    expect(refusalCopy('trade.order_type_unsupported')).toEqual({
      title: "That order type isn't offered",
      body: 'This market takes limit and market orders only.',
    });
    expect(refusalCopy('trade.below_min_notional')).toEqual({ title: 'Amount is too small', body: 'Enter a larger amount to continue.' });
    expect(refusalCopy('trade.orders_paused').title).toBe('Orders are paused right now');
    for (const code of [
      'trade.post_only_would_cross',
      'fok_unfillable',
      'trade.order_type_unsupported',
      'trade.invalid_tif',
      'trade.orders_paused',
    ])
      expect(`${refusalCopy(code).title} ${refusalCopy(code).body}`).not.toMatch(/trade\.|_would_|_unfillable|_unsupported|_tif/);
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
      ['posting_frozen', 'accountOnHold'],
      ['mfa.required', 'stepUp'],
      ['auth.mfa_required', 'mfaRequired'],
      ['bank.prices_unavailable', 'pricesDown'],
      ['auth.required', 'signedOut'],
      ['bank.below_minimum', 'belowMinimum'],
      ['trade.self_trade', 'selfTrade'],
      ['trade.order_type_unsupported', 'orderTypeUnsupported'],
      ['trade.post_only_would_cross', 'postOnlyWouldCross'],
      ['post_only_would_cross', 'postOnlyWouldCross'],
      ['fok_unfillable', 'fokUnfillable'],
      ['trade.invalid_tif', 'tifInvalid'],
      ['trade.oco_price_order', 'exitPriceOrder'],
      ['trade.oco_stop_limit_required', 'exitStopLimitMissing'],
      ['trade.missing_oco_trigger', 'exitMissing'],
      ['trade.bracket_exit_failed', 'exitsNotPlaced'],
      ['trade.below_min_notional', 'belowMinimum'],
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

describe('wallet withdrawal refusals', () => {
  it('uses plain words for a missing travel-rule field and a paused withdrawal', () => {
    expect(refusalCopy('pay.wallet_travel_rule')).toMatchObject({
      title: 'Withdrawal was unsuccessful',
      body: 'Add the missing recipient details and submit the withdrawal again. Nothing was sent.',
    });
    expect(classifyRefusal('pay.wallet_withdraw_unavailable')).toBe('walletPaused');
    expect(classifyRefusal('pay.wallet_forbidden')).toBe('noPermission');
  });
});

describe('scheduled order refusals', () => {
  it('says the scheduler is off and that nothing was saved', () => {
    expect(refusalCopy('trade.algo_jobs_disabled')).toEqual({
      title: 'Scheduled orders are off',
      body: 'Nothing was saved. A schedule placed now would stay open and send no orders.',
    });
    expect(refusalCopy('trade.algo_jobs_unknown')).toMatchObject({
      title: 'Something went wrong on our side',
      body: 'Nothing was changed. Try again in a moment.',
    });
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
