import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type UserVenueAccount,
  type UserVenueMarket,
  type VenueIntent,
  type VenueSigner,
} from '@intafaced/venue-contracts';
import { unreadMarketTerms } from './market-terms.js';
import { NOT_OFFERED } from './not-offered.js';
import { HL_TESTNET_VENUE_ID, HyperliquidTestnetUserVenue, type FetchLike } from './venue.js';

/**
 * venue.ts was once changed by 16 merged PRs in 7 days: each venue contract change added a read, a
 * `not_offered` case or an unread market term there. Each now has a home of its own; this keeps them out of venue.ts.
 */

/** The signed side's own members: preview, prepare, submit and what they build with. */
const VENUE_OWN = ['constructor', 'preview', 'prepare', 'build', 'buildOwn', 'orderWire', 'submit', 'outcomeOf', 'post'];

const NOW = Date.UTC(2026, 10, 9, 0, 0, 0);
const OWNER = '0x00000000000000000000000000000000000000a1';
const account: UserVenueAccount = { venueId: HL_TESTNET_VENUE_ID, owner: OWNER, subAccount: null };
const ownerSigner: VenueSigner = { role: 'owner', address: OWNER };
const a = parseAmount;
const SUB = '0x00000000000000000000000000000000000000c3';
const ORDER: PlaceUserOrderIntent = {
  kind: 'place_order',
  symbol: 'ETH-PERP',
  side: 'buy',
  type: 'limit',
  amount: a('0.5'),
  price: a('2000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: 'order:test-user:desk:1',
  builderFee: null,
};

/** A well-formed intent of every kind NOT_OFFERED names: a kind added there fails to compile until it is here too. */
const NOT_OFFERED_INTENTS: { readonly [K in keyof typeof NOT_OFFERED]: Extract<VenueIntent, { kind: K }> } = {
  revoke_agent: { kind: 'revoke_agent', agentAddress: SUB },
  amend_order: { kind: 'amend_order', symbol: 'ETH-PERP', venueClientOrderId: '0x01', amount: a('1'), price: a('1') },
  replace_order: { kind: 'replace_order', symbol: 'ETH-PERP', venueClientOrderId: '0x01', order: ORDER },
  cancel_orders: { kind: 'cancel_orders', orders: [{ symbol: 'ETH-PERP', venueClientOrderId: '0x01' }] },
  schedule_cancel: { kind: 'schedule_cancel', timeoutSec: 60, time: null },
  create_sub_account: { kind: 'create_sub_account', name: 'TEST sub', subAccountKey: 'sub:owner:1' },
  sub_account_transfer: {
    kind: 'sub_account_transfer',
    subAccount: SUB,
    direction: 'into_sub_account',
    asset: 'USDC',
    amount: a('1'),
    moveKey: 'move:owner:1',
  },
  market_margin_transfer: {
    kind: 'market_margin_transfer',
    symbol: 'ETH-PERP',
    direction: 'into_market',
    asset: 'USDC',
    amount: a('1'),
    moveKey: 'move:owner:2',
  },
  update_isolated_margin: {
    kind: 'update_isolated_margin',
    symbol: 'ETH-PERP',
    direction: 'add',
    amount: a('1'),
    changeKey: 'change:owner:1',
  },
  place_orders: { kind: 'place_orders', orders: [ORDER], actionKey: 'action:owner:1' },
  spot_perps_transfer: { kind: 'spot_perps_transfer', direction: 'perps_to_spot', asset: 'USDC', amount: a('1'), moveKey: 'move:owner:3' },
  set_account_mode: { kind: 'set_account_mode', mode: 'unified', changeKey: 'change:owner:2' },
  vault_transfer: { kind: 'vault_transfer', vault: SUB, direction: 'deposit', asset: 'USDC', amount: a('1'), moveKey: 'move:owner:4' },
};

/** The info answers `markets` reads: a perp listing, a spot listing and the account's fee rates. */
const INFO: Record<string, unknown> = {
  meta: { universe: [{ name: 'ETH', szDecimals: 4, maxLeverage: 25 }] },
  spotMeta: {
    tokens: [
      { name: 'USDC', szDecimals: 8, weiDecimals: 8, index: 0 },
      { name: 'PURR', szDecimals: 0, weiDecimals: 5, index: 1 },
    ],
    universe: [{ name: 'PURR/USDC', tokens: [1, 0], index: 0 }],
  },
  userFees: { userCrossRate: '0.00035', userAddRate: '0.0001', userSpotCrossRate: '0.0007', userSpotAddRate: '0.0004' },
};

function venue(): { venue: HyperliquidTestnetUserVenue; exchangeCalls: () => number } {
  let exchange = 0;
  const fetch: FetchLike = async (url, init) => {
    if (!url.endsWith('/info')) {
      exchange += 1;
      return { ok: false, status: 500, text: async () => 'nothing is sent from these tests' };
    }
    const answer = INFO[String((JSON.parse(init.body) as { type?: unknown }).type)];
    if (answer === undefined) return { ok: false, status: 400, text: async () => 'unknown info type' };
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
  };
  const v = new HyperliquidTestnetUserVenue({ appEnv: 'test', fetch, clock: () => new Date(NOW), timeoutMs: 50 });
  return { venue: v, exchangeCalls: () => exchange };
}

describe('the Hyperliquid adapter keeps each kind of change in its own file', () => {
  it('venue.ts declares only the signed side: a new read goes in reads.ts', () => {
    const members = Object.getOwnPropertyNames(HyperliquidTestnetUserVenue.prototype);
    expect(
      members.filter((m) => !VENUE_OWN.includes(m)),
      'a UserVenue read goes in src/reads.ts (HyperliquidReads), never in venue.ts',
    ).toEqual([]);
    // The reads are still there, inherited from HyperliquidReads.
    expect(typeof HyperliquidTestnetUserVenue.prototype.markets).toBe('function');
  });

  it('venue.ts writes no "not offered" refusal of its own: a kind this adapter does not build goes in not-offered.ts', async () => {
    const { venue: v, exchangeCalls } = venue();
    for (const [kind, why] of Object.entries(NOT_OFFERED)) {
      expect(why, kind).toMatch(/not offered/);
      const intent: VenueIntent = NOT_OFFERED_INTENTS[kind as keyof typeof NOT_OFFERED];
      const error = await v.prepare(account, ownerSigner, intent).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, kind).toBeInstanceOf(VenueRefusalError);
      expect(
        (error as VenueRefusalError).refusal,
        "an intent kind this adapter does not build is one line in NOT_OFFERED (src/not-offered.ts), never a case in venue.ts' switch",
      ).toMatchObject({ code: 'not_offered', detail: why });
    }
    expect(exchangeCalls()).toBe(0);
  });

  it('the terms markets() reads hold no unknown or null of their own: an unread term goes in market-terms.ts', async () => {
    const markets = (await venue().venue.markets(account)).value;
    expect(markets.map((m) => m.symbol).sort()).toEqual(['ETH-PERP', 'PURR-USDC']);
    const unread = unreadMarketTerms();
    const readTerms = Object.keys(markets[0]!).filter((term) => !Object.hasOwn(unread, term)) as (keyof UserVenueMarket)[];
    for (const m of markets) expect(Object.keys(m).sort()).toEqual([...readTerms, ...Object.keys(unread)].sort());
    for (const m of markets)
      for (const [term, value] of Object.entries(unread)) expect(m[term as keyof UserVenueMarket], term).toEqual(value);
    const neverKnown = readTerms.filter((term) =>
      markets.every((m) => {
        const value: unknown = m[term];
        return value === null || (typeof value === 'object' && value !== null && 'known' in value && value.known === false);
      }),
    );
    expect(
      neverKnown,
      'a market term this adapter does not read is one line in unreadMarketTerms (src/market-terms.ts), not known or null there',
    ).toEqual([]);
  });
});
