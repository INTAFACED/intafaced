import http from 'node:http';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  VenueWireError,
  decodeVenueWire,
  encodeVenueWire,
  refuseTestVenueOutsideTest,
  venueClientOrderId,
  type AsOf,
  type MaybeKnown,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type UserVenueDepositRoute,
  type UserVenueMarketStatus,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
} from '@intafaced/venue-contracts';
import type { TestVenueTypedData } from './signing.js';
import { TEST_VENUE_FIGURE_STALE_AFTER_MS, TestVenueSimulator, type SimMarketConfig } from './simulator.js';

/**
 * THE TEST VENUE SIMULATOR OVER LOOPBACK HTTP — one `TestVenueSimulator` as an outside process, so "venue down" is a
 * real outside failure and svc-trade reaches it the way it will reach a real venue (services/svc-trade
 * src/venue/http-user-venue.ts).
 *
 * JSON in and out, every Amount as a decimal string and every time as ISO (`encodeVenueWire`). Every route is a POST
 * with a JSON body except `GET /health` and `GET /venue`. A `VenueRefusalError` answers 422 `{ refusal }`; a body
 * that does not parse answers 400. Routes:
 *
 *   GET  /health, GET /venue                         descriptor, chain id, label TEST, and the deposit route (or null)
 *   POST /markets {account|null}, /preview {account,intent}, /prepare {account,signer,intent},
 *        /submit {prepared,signature}, /balances|/open-orders|/positions|/agents {account},
 *        /order-by-client-id {account,venueClientOrderId}, /fills {account,since}, /withdrawal {account,nonce}, /deposits {account},
 *        /builder-fee-approval {account,builder}, /builder-totals {builder}, /builder-claims {builder},
 *        /leverage {account,symbol}, /book {symbol,depth},
 *        /sub-accounts {account}, /transfer {account,nonce}   (UserVenueSubAccountReads, on the main account)
 *        /market-margin {account,symbol}                  the owner's balance in a market deployer's own margin account
 *        /settlements {account,since}                     the account's settlements in a deployer's halt or a split
 *   TEST controls (never part of UserVenue):
 *   POST /test/deposit {account,asset,amount,depositRef}   idempotent by depositRef
 *        /test/switches {venueDown?,unlistPerpetuals?,withdrawalFee?,networkFee?,depositExplorerTxUrl?}   each fee a MaybeKnown<Amount>
 *        /test/account-switches {owner,down?,loseAnswers?,failAfterSend?,submitDelayMs?}   one owner's account only, so a journey can
 *                                                         take the venue away from its own person and no one else's:
 *                                                         `down` refuses every call on that owner's account venue_down;
 *                                                         `loseAnswers` applies the next N submits and answers each
 *                                                         `definite: false` (timeout); `failAfterSend` applies the next N
 *                                                         submits and answers each HTTP 500; `submitDelayMs` holds each submit
 *                                                         that long (at most 10 s) before the venue applies it
 *        /test/settle-withdrawals, /test/set-mark {symbol,price}
 *        /test/builder-claim {builder}                     the builder claims every unclaimed builder fee into its own account
 *        /test/fills {since}                              every account's fills since a time, with its account
 *        /test/seed                                       TEST makers rest a two-sided ladder on BTC-USDC, BTC-PERP, XAU-PERP,
 *                                                         XSTK-PERP and XSTD-PERP
 *        /test/lose-answers {account,count}               the account's next `count` submits apply, answer not definite
 *        /test/expire-agent {account,agentAddress}        the agent's expiry passes now (it stays listed, expired)
 *        /test/market-status {symbol,status}             the market's own state: trading|halted|cancel_only|delisted|null
 *        /test/market-limits {symbol,maxOrderQty,maxOrderNotional}   decimal strings, or null for "not reported"
 *        /test/market-fees {symbol,makerFeeBps,takerFeeBps}   decimal bps, or null for "not published"
 *        /test/market-add {symbol,baseAsset,quoteAsset,maxOrderQty,maxOrderNotional}   one more TEST cash spot market,
 *                                                         tick 0.1, lot 0.001, no ladder; refused if already listed
 *        /test/feed {symbol,state: 'live'|'stale'}        an oracle market's feed goes stale (the oracle stops) or live
 *        /test/session {symbol,state: 'open'|'off_hours',published?}  a stock perpetual's home market closes (the
 *                                                         venue's off-hours mode applies) or opens again; `published:
 *                                                         false` publishes none of its off-hours words, `true` all again
 *        /test/market-leverage {symbol,maxLeverageBps}    the most leverage the venue now allows on a perpetual
 *        /test/open-interest-cap {symbol,capSize}         the deployer's cap on a market's open interest (base units, or null)
 *        /test/deployer-halt {symbol}                     the deployer halts the market: orders cancelled, positions settled
 *                                                         at the mark; /test/market-status trading resumes it
 *        /test/split {symbol,ratio}                       a TEST split: orders cancelled, positions settled at the mark, the
 *                                                         market reopened at once with its mark divided by the ratio
 *
 * TEST ONLY: `startTestVenueServer` refuses to start unless APP_ENV is exactly `dev` or `test`, and binds loopback.
 */

/** The venue itself as the lister of its own markets (the BTC markets). */
const VENUE_LISTED = { kind: 'venue', name: 'TEST venue simulator' } as const;

/**
 * The stack's TEST markets: BTC-USDC cash spot, the BTC-PERP perpetual, ETH-USDC cash spot with no ladder (a market the
 * venue lists that INTAFACED has not reviewed: J-cex-spot-16), and XAU-PERP, a TEST gold perpetual a TEST HIP-3 deployer
 * lists, priced by the simulator's own TEST oracle; perpetuals take isolated margin only. Every market starts `trading`
 * with a TEST largest order. Every figure and word is TEST: the oracle reads no outside gold price.
 */
export const TEST_VENUE_MARKETS: readonly SimMarketConfig[] = [
  {
    symbol: 'BTC-USDC',
    kind: 'spot',
    baseAsset: 'BTC',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC', 'ALO'],
    marginModes: [],
    maxLeverageBps: null,
    tickSize: parseAmount('1'),
    lotSize: parseAmount('0.0001'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3.5') },
    status: 'trading',
    // TEST: roomy enough for every journey's TEST orders on the shared BTC markets (J-cex-spot-01 #8 sells 100 BTC);
    // J-cex-spot-16 proves the venue's own caps on TEST markets of its own (/test/market-add, /test/market-limits).
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('100000000'),
    // TEST: the venue's own cap on a builder fee, 1% on spot (the figure Hyperliquid publishes for its builder codes).
    builderFeeCapBps: { known: true, value: parseAmount('100') },
  },
  {
    symbol: 'BTC-PERP',
    kind: 'perpetual',
    baseAsset: 'BTC',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 200_000,
    tickSize: parseAmount('1'),
    lotSize: parseAmount('0.0001'),
    makerFeeBps: { known: true, value: parseAmount('1.5') },
    takerFeeBps: { known: true, value: parseAmount('4.5') },
    // TEST: the venue's own cap on a builder fee, 0.1% on perpetuals (the figure Hyperliquid publishes for its builder codes).
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.005'),
    markPrice: parseAmount('60000'),
    // TEST: one contract is one BTC, and the venue publishes a TEST hourly funding rate of 0.00125% (it settles none).
    contractSize: parseAmount('1'),
    funding: { rate: parseAmount('0.0000125'), intervalSeconds: 3600 },
    status: 'trading',
    // TEST: roomy enough for every journey's TEST orders on the shared BTC markets (J-cex-spot-01 #8 sells 100 BTC);
    // J-cex-spot-16 proves the venue's own caps on TEST markets of its own (/test/market-add, /test/market-limits).
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('100000000'),
    listedBy: VENUE_LISTED,
  },
  {
    symbol: 'ETH-USDC',
    kind: 'spot',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC', 'ALO'],
    marginModes: [],
    maxLeverageBps: null,
    tickSize: parseAmount('0.1'),
    lotSize: parseAmount('0.001'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3.5') },
    status: 'trading',
    maxOrderQty: parseAmount('500'),
    maxOrderNotional: parseAmount('2000000'),
    // TEST: the same spot builder-fee cap as BTC-USDC.
    builderFeeCapBps: { known: true, value: parseAmount('100') },
  },

  {
    symbol: 'XAU-PERP',
    kind: 'perpetual',
    baseAsset: 'XAU',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
    tickSize: parseAmount('0.1'),
    lotSize: parseAmount('0.01'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3') },
    // TEST: the same perpetual builder-fee cap as BTC-PERP.
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.01'),
    markPrice: parseAmount('2650'),
    // TEST: one contract is one unit of the base; no funding rate is published for it.
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('10000000'),
    listedBy: { kind: 'hip3', name: 'TEST gold deployer' },
    oracleRule: "TEST oracle: one XAU/USD price, set by the simulator's TEST control; it reads no outside gold price.",
    markRule: 'The mark price is the oracle price; fills do not move it.',
    tradingHours: '24/7, no close',
    oracle: {
      staleRule: 'While the oracle is stale the mark holds at the last oracle price and only reduce-only orders are taken.',
    },
  },
  {
    // J-derivatives-27: a TEST stock perpetual a TEST HIP-3 deployer lists, priced by the simulator's own TEST feed, with
    // a TEST home market whose hours the simulator's TEST control sets. It tracks no real company's share.
    symbol: 'XSTK-PERP',
    kind: 'perpetual',
    baseAsset: 'XSTK',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.1'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3') },
    // TEST: the same perpetual builder-fee cap as BTC-PERP.
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.02'),
    markPrice: parseAmount('200'),
    // TEST: one contract is one unit of the base; no funding rate is published for it.
    contractSize: parseAmount('1'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    listedBy: { kind: 'hip3', name: 'TEST stock deployer' },
    oracleRule:
      "TEST price feed: one XSTK/USD price for a TEST stock, set by the simulator's TEST control; it reads no outside share price.",
    markRule: 'The mark price is the feed price; fills do not move it.',
    tradingHours:
      "24/7 on the venue. The TEST home market's hours are set by the simulator's TEST control; while it is closed the venue's off-hours mode applies.",
    oracle: {
      staleRule: 'While the feed is stale the mark holds at the last feed price and only reduce-only orders are taken.',
    },
    session: {
      homeMarket: 'TEST home exchange',
      offHoursMode: 'The mark holds at the last open-hours price; only limit orders inside the band are taken, at reduced leverage.',
      offHoursBand: 'Limit prices within 5% of the mark when the home market closed.',
      offHoursBandBps: 500,
      offHoursMaxLeverageBps: 20_000,
      offHoursRule:
        'Off hours XSTK-PERP takes no market orders, and only limit orders within 5% of the closing mark at up to 2x; market orders wait for the home market to reopen.',
      // TEST: the venue publishes a reopen time one hour after the TEST control closes the home market.
      reopensAfterMs: 3_600_000,
    },
  },
  {
    // J-derivatives-27 #7 to #10: a second TEST stock perpetual, listed by a TEST HIP-3 deployer that keeps its own margin
    // account for it (as a HIP-3 deployer's market is margined apart from the main account), with its own collateral and
    // margin mode and a cap on its open interest. Priced by the simulator's own TEST feed; it tracks no real company's share.
    symbol: 'XSTD-PERP',
    kind: 'perpetual',
    baseAsset: 'XSTD',
    quoteAsset: 'USDC',
    orderTypes: ['limit', 'market'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100_000,
    tickSize: parseAmount('0.01'),
    lotSize: parseAmount('0.1'),
    makerFeeBps: { known: true, value: parseAmount('1') },
    takerFeeBps: { known: true, value: parseAmount('3') },
    // TEST: the same perpetual builder-fee cap as BTC-PERP.
    builderFeeCapBps: { known: true, value: parseAmount('10') },
    maintenanceMarginRate: parseAmount('0.02'),
    markPrice: parseAmount('100'),
    status: 'trading',
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('1000000'),
    listedBy: { kind: 'hip3', name: 'TEST stock margin deployer' },
    oracleRule:
      "TEST price feed: one XSTD/USD price for a TEST stock, set by the simulator's TEST control; it reads no outside share price.",
    markRule: 'The mark price is the feed price; fills do not move it.',
    tradingHours: '24/7 on the venue.',
    oracle: {
      staleRule: 'While the feed is stale the mark holds at the last feed price and only reduce-only orders are taken.',
    },
    marginAccount: { name: 'TEST stock margin deployer margin', collateralAsset: 'USDC', marginMode: 'isolated' },
    // TEST: room for every TEST order on it; J-derivatives-27 #8 lowers it for one step.
    openInterestCap: parseAmount('500'),
  },
];

/** The markets `seed` rests a ladder on, each around its own price (SEED_LADDERS). */
const LADDER_SYMBOLS: ReadonlySet<string> = new Set(['BTC-USDC', 'BTC-PERP', 'XAU-PERP', 'XSTK-PERP', 'XSTD-PERP']);
const MARKET_STATUSES: ReadonlySet<string> = new Set(['trading', 'halted', 'cancel_only', 'delisted']);

/**
 * The ladder `seed` rests on each market, five levels a side, around the market's own price: BTC around 60000, 10 apart,
 * 1 BTC each; XAU-PERP around its oracle price 2650, 0.5 apart, 1 XAU each; XSTK-PERP around its feed price 200, 0.1
 * apart, 1 XSTK each. TEST.
 */
const SEED_LEVELS = 5;
/** Each level's size, in the market's base asset, unless `seedTestVenue` is given its own `levelSize`. TEST. */
const SEED_SIZE = '1';
const SEED_LADDERS: Readonly<Record<string, { mid: Amount; step: Amount }>> = {
  'BTC-USDC': { mid: parseAmount('60000'), step: parseAmount('10') },
  'BTC-PERP': { mid: parseAmount('60000'), step: parseAmount('10') },
  'XAU-PERP': { mid: parseAmount('2650'), step: parseAmount('0.5') },
  'XSTK-PERP': { mid: parseAmount('200'), step: parseAmount('0.1') },
  'XSTD-PERP': { mid: parseAmount('100'), step: parseAmount('0.1') },
};

/** A TEST key derived from a public name. It holds nothing anywhere but the simulator's memory. */
function testMakerKey(name: string) {
  return privateKeyToAccount(keccak256(toHex(`intafaced TEST venue maker ${name}`)));
}

export interface TestVenueHttpOptions {
  readonly sim: TestVenueSimulator;
  /** Where a wallet sends a token to fund its venue account on the TEST chain (chain-deposits.ts), or null when none. */
  readonly deposit?: UserVenueDepositRoute | null;
}

type Answer = readonly [status: number, body: unknown];

function account(body: Record<string, unknown>): UserVenueAccount {
  const a = body.account as UserVenueAccount | undefined;
  if (!a || typeof a.owner !== 'string' || typeof a.venueId !== 'string') throw new VenueWireError('account is required');
  return { venueId: a.venueId, owner: a.owner.toLowerCase(), subAccount: a.subAccount ?? null };
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new VenueWireError(`${key} is required`);
  return v;
}

/** A fee switch: `{ known: false }`, or `{ known: true, value: <decimal string> }` (decoded to an Amount). */
function maybeKnownAmount(raw: unknown, key: string): MaybeKnown<Amount> {
  const v = raw as { known?: unknown; value?: unknown } | null;
  if (v && v.known === false) return { known: false };
  if (v && v.known === true && typeof v.value === 'bigint' && v.value >= 0n) return { known: true, value: v.value as Amount };
  throw new VenueWireError(`${key} must be { known: false } or { known: true, value: "<decimal>" }`);
}

/** Signs and submits as a TEST maker. A refusal or a lost answer stops the seed loudly. */
async function makerRun(sim: TestVenueSimulator, name: string, intent: VenueIntent): Promise<void> {
  const key = testMakerKey(name);
  const owner = key.address.toLowerCase();
  const acct: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer: VenueSigner = { role: 'owner', address: owner };
  const prepared = await sim.prepare(acct, signer, intent);
  const typed = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const outcome = await sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  if (!outcome.definite || !outcome.accepted)
    throw new Error(`TEST seed: ${name} ${intent.kind} was not accepted: ${JSON.stringify(encodeVenueWire(outcome))}`);
}

/** The ladder size each simulator was first seeded with, so `/test/seed` puts back the same ladder. */
const seededLevelSize = new WeakMap<TestVenueSimulator, string>();

/**
 * Fund two TEST makers and rest a two-sided ladder (`levelSize` of the base asset a level, default 1) on every market (one maker a side: the simulator offers opening
 * orders on one side of a perpetual per account). Idempotent: deposits by ref, orders by client key, so a second seed
 * adds nothing and a ladder level that was taken is not put back.
 */
export async function seedTestVenue(
  sim: TestVenueSimulator,
  opts: { readonly levelSize?: string } = {},
): Promise<{ makers: readonly string[]; orders: number }> {
  const size = opts.levelSize ?? seededLevelSize.get(sim) ?? SEED_SIZE;
  seededLevelSize.set(sim, size);
  const levelSize = parseAmount(size);
  const makers = { bid: 'bid', ask: 'ask' } as const;
  let orders = 0;
  for (const side of ['bid', 'ask'] as const) {
    const name = makers[side];
    const owner = testMakerKey(name).address.toLowerCase();
    const acct: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
    sim.deposit(acct, 'USDC', parseAmount('100000000'), `seed:${name}:USDC`);
    sim.deposit(acct, 'BTC', parseAmount('1000'), `seed:${name}:BTC`);
    for (const market of TEST_VENUE_MARKETS) {
      if (!LADDER_SYMBOLS.has(market.symbol)) continue;
      if (market.kind === 'perpetual') {
        const lev = await sim.leverage(acct, market.symbol);
        if (!lev.value)
          await makerRun(sim, name, { kind: 'update_leverage', symbol: market.symbol, leverageBps: 100_000, marginMode: 'isolated' });
        // A market with its deployer's own margin account is margined there: the maker moves TEST collateral in, signed.
        if (market.marginAccount) {
          const margin = await sim.marketMargin(acct, market.symbol);
          if (margin.value.free < parseAmount('100000'))
            await makerRun(sim, name, {
              kind: 'market_margin_transfer',
              symbol: market.symbol,
              direction: 'into_market',
              asset: market.marginAccount.collateralAsset,
              amount: parseAmount('1000000'),
              moveKey: `market-margin:test-maker-${name}:seed:${market.symbol}`,
            });
        }
      }
      const ladder = SEED_LADDERS[market.symbol];
      if (!ladder) throw new Error(`TEST seed: no ladder for ${market.symbol}`);
      for (let level = 1; level <= SEED_LEVELS; level += 1) {
        const offset = ladder.step * BigInt(level);
        const price = side === 'bid' ? ladder.mid - offset : ladder.mid + offset;
        // A level the maker still rests is kept. One the venue cancelled (a deployer's halt, a split) rests again under a
        // new key, since a client order id names one order for good.
        const base = `order:test-maker-${name}:seed:${market.symbol}:${level}`;
        let clientOrderKey = base;
        for (let again = 1; ; again += 1) {
          const seen = (await sim.orderByClientId(acct, venueClientOrderId(sim.venue.id, clientOrderKey))).value;
          if (!seen || seen.status === 'open' || seen.status === 'partially_filled') break;
          clientOrderKey = `${base}:again-${again}`;
        }
        const resting = (await sim.orderByClientId(acct, venueClientOrderId(sim.venue.id, clientOrderKey))).value;
        if (resting) continue;
        const intent: PlaceUserOrderIntent = {
          kind: 'place_order',
          symbol: market.symbol,
          side: side === 'bid' ? 'buy' : 'sell',
          type: 'limit',
          amount: levelSize,
          price,
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey,
          builderFee: null,
        };
        await makerRun(sim, name, intent);
        orders += 1;
      }
    }
  }
  return { makers: [testMakerKey('bid').address.toLowerCase(), testMakerKey('ask').address.toLowerCase()], orders };
}

/** One owner's TEST switches (`/test/account-switches`). Kept per simulator, never part of UserVenue. */
export interface AccountSwitches {
  down: boolean;
  /**
   * The account's balance and position figures (b2 change 6): `live` (the default) sends each read with the venue's time
   * now; `stale` sends it with a time older than the venue's declared limit (`TEST_VENUE_FIGURE_STALE_AFTER_MS`);
   * `unknown` sends it with no time, so every figure reads "not known", never known at our read time.
   */
  figures: 'live' | 'stale' | 'unknown';
  loseAnswers: number;
  failAfterSend: number;
  submitDelayMs: number;
}

const ACCOUNT_SWITCHES = new WeakMap<TestVenueSimulator, Map<string, AccountSwitches>>();

function switchesOf(sim: TestVenueSimulator, owner: string): AccountSwitches | null {
  return ACCOUNT_SWITCHES.get(sim)?.get(owner.toLowerCase()) ?? null;
}

/** A balance or position read with the venue's time as the account's `figures` switch says (b2 change 6). */
function figuresAsSwitched<T>(sim: TestVenueSimulator, owner: string, read: AsOf<T>): AsOf<T> {
  const mode = switchesOf(sim, owner)?.figures ?? 'live';
  if (mode === 'live') return read;
  if (mode === 'unknown') return { ...read, reportedAt: null };
  return { ...read, reportedAt: new Date(read.asOf.getTime() - 2 * TEST_VENUE_FIGURE_STALE_AFTER_MS) };
}

/** The owner a request acts on: its `account`, or the prepared action's account on a submit. */
function ownerOf(body: Record<string, unknown>): string | null {
  const a = (body.account ?? (body.prepared as { account?: unknown } | undefined)?.account) as { owner?: unknown } | undefined;
  return a && typeof a.owner === 'string' ? a.owner.toLowerCase() : null;
}

function setAccountSwitches(sim: TestVenueSimulator, body: Record<string, unknown>): AccountSwitches & { owner: string } {
  const owner = str(body, 'owner').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new VenueWireError('owner must be a 0x address');
  const all = ACCOUNT_SWITCHES.get(sim) ?? new Map<string, AccountSwitches>();
  ACCOUNT_SWITCHES.set(sim, all);
  const s = all.get(owner) ?? { down: false, figures: 'live', loseAnswers: 0, failAfterSend: 0, submitDelayMs: 0 };
  if (body.figures !== undefined) {
    if (body.figures !== 'live' && body.figures !== 'stale' && body.figures !== 'unknown') {
      throw new VenueWireError("figures is 'live', 'stale' or 'unknown'");
    }
    s.figures = body.figures;
  }
  if (body.down !== undefined) {
    if (typeof body.down !== 'boolean') throw new VenueWireError('down is true or false');
    s.down = body.down;
  }
  const whole = (k: 'loseAnswers' | 'failAfterSend' | 'submitDelayMs', max: number) => {
    const v = body[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new VenueWireError(`${k} is a whole number 0 to ${max}`);
    s[k] = v;
  };
  whole('loseAnswers', 100);
  whole('failAfterSend', 100);
  whole('submitDelayMs', 10_000);
  all.set(owner, s);
  return { owner, ...s };
}

/** One request's answer. Exported so a test can drive it without a socket. */
export async function answerTestVenue(
  sim: TestVenueSimulator,
  method: string,
  path: string,
  rawBody: string,
  deposit: UserVenueDepositRoute | null = null,
): Promise<Answer> {
  if (method === 'GET' && path === '/health') return [200, { ok: true, label: 'TEST', venue: sim.venue.id, chainId: sim.chainId }];
  if (method === 'GET' && path === '/venue') return [200, { label: 'TEST', venue: sim.venue, chainId: sim.chainId, deposit }];
  if (method !== 'POST') return [405, { error: 'POST only' }];
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [400, { error: 'the body must be a JSON object' }];
    body = decodeVenueWire<Record<string, unknown>>(parsed);
  } catch (err) {
    return [400, { error: (err as Error).message }];
  }
  try {
    const owner = path.startsWith('/test/') ? null : ownerOf(body);
    const mine = owner ? switchesOf(sim, owner) : null;
    if (mine?.down) {
      throw new VenueRefusalError({
        venueId: sim.venue.id,
        code: 'venue_down',
        detail: `${sim.venue.displayName} is down for this account (TEST switch)`,
      });
    }
    if (path === '/submit' && mine && mine.submitDelayMs > 0) await new Promise((r) => setTimeout(r, mine.submitDelayMs));
    if (path === '/submit' && mine && mine.loseAnswers > 0) {
      // Applied, then the answer is lost, as a timeout after the bytes reached the venue.
      await route(sim, path, body);
      mine.loseAnswers -= 1;
      return [200, encodeVenueWire({ definite: false, reason: 'timeout' })];
    }
    if (path === '/submit' && mine && mine.failAfterSend > 0) {
      // Applied, then the venue answers a 5xx: an error after the bytes reached the venue.
      await route(sim, path, body);
      mine.failAfterSend -= 1;
      return [500, { error: 'TEST venue error after the submit was applied (TEST switch)' }];
    }
    const value = await route(sim, path, body);
    return value === undefined ? [404, { error: `no route ${path}` }] : [200, encodeVenueWire(value)];
  } catch (err) {
    if (err instanceof VenueRefusalError) return [422, { refusal: err.refusal }];
    if (err instanceof VenueWireError) return [400, { error: err.message }];
    return [500, { error: (err as Error).message }];
  }
}

async function route(sim: TestVenueSimulator, path: string, body: Record<string, unknown>): Promise<unknown> {
  switch (path) {
    case '/markets':
      return sim.markets(body.account ? account(body) : null);
    case '/book': {
      const depth = body.depth;
      if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 50)
        throw new VenueWireError('depth is a whole number from 1 to 50');
      return sim.book(str(body, 'symbol'), depth);
    }
    case '/preview':
      return sim.preview(account(body), body.intent as PlaceUserOrderIntent);
    case '/best-prices':
      return sim.bestPrices(str(body, 'symbol'));
    case '/funding-history': {
      const since = body.since;
      if (!(since instanceof Date)) throw new VenueWireError('since is required (an ISO time)');
      return sim.fundingHistory(str(body, 'symbol'), since);
    }
    case '/prepare':
      return sim.prepare(account(body), body.signer as VenueSigner, body.intent as VenueIntent);
    case '/submit':
      return sim.submit(body.prepared as PreparedVenueAction, body.signature as VenueSignature);
    case '/balances':
      return figuresAsSwitched(sim, account(body).owner, await sim.balances(account(body)));
    case '/open-orders':
      return sim.openOrders(account(body));
    case '/positions':
      return figuresAsSwitched(sim, account(body).owner, await sim.positions(account(body)));
    case '/agents':
      return sim.agents(account(body));
    case '/order-by-client-id':
      return sim.orderByClientId(account(body), str(body, 'venueClientOrderId'));
    case '/order-signer':
      return sim.orderSigner(account(body), str(body, 'venueClientOrderId'));
    case '/fills': {
      const since = body.since;
      if (!(since instanceof Date)) throw new VenueWireError('since is required (an ISO time)');
      return sim.fills(account(body), since);
    }
    case '/withdrawal':
      return sim.withdrawal(account(body), str(body, 'nonce'));
    case '/deposits':
      return sim.deposits(account(body));
    case '/arrivals':
      return sim.arrivals(account(body));
    case '/builder-fee-approval':
      return sim.builderFeeApproval(account(body), str(body, 'builder'));
    case '/builder-totals':
      return sim.builderTotals(str(body, 'builder'));
    case '/builder-claims':
      return sim.builderClaims(str(body, 'builder'));
    case '/leverage':
      return sim.leverage(account(body), str(body, 'symbol'));
    case '/sub-accounts':
      return sim.subAccounts(account(body));
    case '/transfer':
      return sim.transfer(account(body), str(body, 'nonce'));
    case '/market-margin':
      return sim.marketMargin(account(body), str(body, 'symbol'));
    case '/settlements': {
      const since = body.since;
      if (!(since instanceof Date)) throw new VenueWireError('since is required (an ISO time)');
      return sim.settlements(account(body), since);
    }
    // ── TEST controls ──
    case '/test/deposit': {
      const amount = body.amount;
      if (typeof amount !== 'bigint') throw new VenueWireError('amount is required (a decimal string)');
      return { credited: sim.deposit(account(body), str(body, 'asset'), amount as Amount, str(body, 'depositRef')), label: 'TEST' };
    }
    case '/test/switches': {
      if (typeof body.venueDown === 'boolean') sim.switches.venueDown = body.venueDown;
      if (typeof body.unlistPerpetuals === 'boolean') sim.switches.unlistPerpetuals = body.unlistPerpetuals;
      if (typeof body.builderTotalsUnknown === 'boolean') sim.switches.builderTotalsUnknown = body.builderTotalsUnknown;
      if (body.withdrawalFee !== undefined) sim.switches.withdrawalFee = maybeKnownAmount(body.withdrawalFee, 'withdrawalFee');
      if (body.networkFee !== undefined) sim.switches.networkFee = maybeKnownAmount(body.networkFee, 'networkFee');
      if (body.depositExplorerTxUrl === null || typeof body.depositExplorerTxUrl === 'string') {
        const url = body.depositExplorerTxUrl;
        if (url !== null && !/^(https:\/\/|\/(?!\/))/.test(url))
          throw new VenueWireError('depositExplorerTxUrl must be https:// or a path');
        sim.switches.depositExplorerTxUrl = url;
      }
      return {
        venueDown: sim.switches.venueDown,
        unlistPerpetuals: sim.switches.unlistPerpetuals,
        builderTotalsUnknown: sim.switches.builderTotalsUnknown,
        withdrawalFee: sim.switches.withdrawalFee,
        networkFee: sim.switches.networkFee,
        depositExplorerTxUrl: sim.switches.depositExplorerTxUrl,
        label: 'TEST',
      };
    }
    case '/test/account-switches':
      return { ...setAccountSwitches(sim, body), label: 'TEST' };
    case '/test/builder-claim':
      return { claims: sim.claimBuilderFees(str(body, 'builder')), label: 'TEST' };
    case '/test/settle-withdrawals':
      return { settled: sim.settleWithdrawals(), label: 'TEST' };
    case '/test/set-mark': {
      const price = body.price;
      if (typeof price !== 'bigint') throw new VenueWireError('price is required (a decimal string)');
      sim.setMark(str(body, 'symbol'), price as Amount);
      return { ok: true, label: 'TEST' };
    }
    case '/test/feed': {
      const state = body.state;
      if (state !== 'live' && state !== 'stale') throw new VenueWireError("state is required ('live' or 'stale')");
      const symbol = str(body, 'symbol');
      sim.setFeed(symbol, state);
      const market = (await sim.markets(null)).value.find((m) => m.symbol === symbol);
      return { feed: market?.feed ?? { known: false }, label: 'TEST' };
    }
    case '/test/session': {
      const state = body.state;
      if (state !== 'open' && state !== 'off_hours') throw new VenueWireError("state is required ('open' or 'off_hours')");
      const symbol = str(body, 'symbol');
      if (body.published !== undefined && typeof body.published !== 'boolean')
        throw new VenueWireError('published is true or false when given');
      sim.setSession(symbol, state);
      if (typeof body.published === 'boolean') sim.setSessionPublished(symbol, body.published);
      const market = (await sim.markets(null)).value.find((m) => m.symbol === symbol);
      return { session: market?.session ?? { known: false }, label: 'TEST' };
    }
    case '/test/fills': {
      const since = body.since;
      if (!(since instanceof Date)) throw new VenueWireError('since is required (an ISO time)');
      return { ...sim.testAllFills(since), label: 'TEST' };
    }
    case '/test/lose-answers': {
      const count = body.count;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        throw new VenueWireError('count is required (a whole number)');
      sim.loseAnswersOn(account(body), count);
      return { ok: true, label: 'TEST' };
    }
    case '/test/expire-agent':
      return { expired: sim.expireAgent(account(body), str(body, 'agentAddress')), label: 'TEST' };
    case '/test/seed':
      return { ...(await seedTestVenue(sim)), label: 'TEST' };
    case '/test/market-status': {
      const status = body.status;
      if (status !== null && (typeof status !== 'string' || !MARKET_STATUSES.has(status)))
        throw new VenueWireError('status is trading, halted, cancel_only, delisted or null');
      sim.setMarketStatus(str(body, 'symbol'), status as UserVenueMarketStatus | null);
      return { ok: true, label: 'TEST' };
    }
    case '/test/market-leverage': {
      const cap = body.maxLeverageBps;
      if (typeof cap !== 'number') throw new VenueWireError('maxLeverageBps is a number of bps');
      const symbol = str(body, 'symbol');
      sim.setMarketMaxLeverage(symbol, cap);
      return { maxLeverageBps: cap, label: 'TEST' };
    }
    case '/test/deployer-halt':
      return { event: sim.settleMarket(str(body, 'symbol'), 'deployer_halt'), label: 'TEST' };
    case '/test/split': {
      let ratio: Amount;
      try {
        ratio = parseAmount(str(body, 'ratio'));
      } catch {
        throw new VenueWireError('ratio is a decimal string above zero');
      }
      return { event: sim.settleMarket(str(body, 'symbol'), 'split', ratio), label: 'TEST' };
    }
    case '/test/open-interest-cap': {
      const cap = body.capSize;
      if (cap !== null && typeof cap !== 'bigint') throw new VenueWireError('capSize is a decimal string of base units, or null');
      const symbol = str(body, 'symbol');
      sim.setOpenInterestCap(symbol, cap as Amount | null);
      const market = (await sim.markets(null)).value.find((m) => m.symbol === symbol);
      return { openInterest: market?.openInterest ?? { known: false }, label: 'TEST' };
    }
    case '/test/market-fees': {
      const fee = (k: string): MaybeKnown<Amount> => {
        const v = body[k];
        if (v === null) return { known: false };
        if (typeof v !== 'bigint' || v < 0n) throw new VenueWireError(`${k} is a decimal string of bps, or null for "not published"`);
        return { known: true, value: v as Amount };
      };
      sim.setMarketFees(str(body, 'symbol'), { makerFeeBps: fee('makerFeeBps'), takerFeeBps: fee('takerFeeBps') });
      return { ok: true, label: 'TEST' };
    }
    case '/test/market-limits': {
      const limit = (k: string): Amount | null => {
        const v = body[k];
        if (v === null) return null;
        if (typeof v !== 'bigint') throw new VenueWireError(`${k} is a decimal string or null`);
        return v as Amount;
      };
      sim.setMarketLimits(str(body, 'symbol'), { maxOrderQty: limit('maxOrderQty'), maxOrderNotional: limit('maxOrderNotional') });
      return { ok: true, label: 'TEST' };
    }
    case '/test/market-add': {
      const symbol = str(body, 'symbol');
      const asset = (k: string): string => {
        const v = str(body, k);
        if (!/^[A-Z0-9]{2,20}$/.test(v)) throw new VenueWireError(`${k} is an asset code (A-Z, 0-9)`);
        return v;
      };
      if (!/^[A-Z0-9][A-Z0-9/._-]{0,63}$/.test(symbol)) throw new VenueWireError('symbol is a venue symbol (A-Z, 0-9, / . _ -)');
      const cap = (k: string): Amount | null => {
        const v = body[k];
        if (v === null) return null;
        if (typeof v !== 'bigint' || v <= 0n) throw new VenueWireError(`${k} is a decimal string above zero, or null`);
        return v as Amount;
      };
      sim.addMarket({
        symbol,
        kind: 'spot',
        baseAsset: asset('baseAsset'),
        quoteAsset: asset('quoteAsset'),
        orderTypes: ['limit', 'market'],
        timeInForce: ['GTC', 'IOC', 'ALO'],
        marginModes: [],
        maxLeverageBps: null,
        tickSize: parseAmount('0.1'),
        lotSize: parseAmount('0.001'),
        makerFeeBps: { known: true, value: parseAmount('1') },
        takerFeeBps: { known: true, value: parseAmount('3.5') },
        status: 'trading',
        maxOrderQty: cap('maxOrderQty'),
        maxOrderNotional: cap('maxOrderNotional'),
        // TEST: the same spot builder-fee cap as BTC-USDC.
        builderFeeCapBps: { known: true, value: parseAmount('100') },
      });
      return { ok: true, symbol, label: 'TEST' };
    }
    default:
      return undefined;
  }
}

/** The HTTP handler for one simulator. Bodies are capped at 1 MiB. */
export function testVenueHandler(sim: TestVenueSimulator, deposit: UserVenueDepositRoute | null = null): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://test-venue').pathname;
      void answerTestVenue(sim, req.method ?? 'GET', path, Buffer.concat(chunks).toString('utf8'), deposit).then(([status, body]) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      });
    });
  };
}

export interface StartTestVenueOptions {
  readonly host: string;
  readonly port: number;
  /** The RAW `process.env.APP_ENV`. Anything but `dev` or `test` refuses to start. */
  readonly appEnv: string | undefined;
  readonly chainId?: number;
  readonly clock?: () => Date;
  /** The venue's id and name, so a stack can run two TEST venues side by side (J-derivatives-28). Defaults: the simulator's. */
  readonly id?: string;
  readonly displayName?: string;
  /** The deposit route `GET /venue` names (the TEST chain's watcher is started by the caller, chain-deposits.ts). */
  readonly deposit?: UserVenueDepositRoute | null;
}

/** Start the TEST venue on loopback. Refuses outside APP_ENV dev/test and on a non-loopback host. */
export async function startTestVenueServer(
  opts: StartTestVenueOptions,
): Promise<{ server: http.Server; sim: TestVenueSimulator; url: string }> {
  if (opts.host !== '127.0.0.1' && opts.host !== '::1' && opts.host !== 'localhost') {
    throw new Error(`the TEST venue listens on loopback only, not ${opts.host}`);
  }
  const sim = new TestVenueSimulator({
    clock: opts.clock ?? (() => new Date()),
    markets: TEST_VENUE_MARKETS,
    chainId: opts.chainId,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
  });
  refuseTestVenueOutsideTest(sim.venue, opts.appEnv);
  const server = http.createServer(testVenueHandler(sim, opts.deposit ?? null));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return { server, sim, url: `http://${opts.host}:${port}` };
}
