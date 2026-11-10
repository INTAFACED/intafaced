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
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';

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
 *        /order-by-client-id {account,venueClientOrderId}, /fills {account,since}, /withdrawal {account,nonce},
 *        /builder-fee-approval {account,builder}, /leverage {account,symbol}
 *   TEST controls (never part of UserVenue):
 *   POST /test/deposit {account,asset,amount,depositRef}   idempotent by depositRef
 *        /test/switches {venueDown?,unlistPerpetuals?,withdrawalFee?,networkFee?}   each fee a MaybeKnown<Amount>
 *        /test/settle-withdrawals, /test/set-mark {symbol,price}
 *        /test/lose-answers {account,count}               the account's next `count` submits apply, answer not definite
 *        /test/expire-agent {account,agentAddress}        the agent's expiry passes now (it stays listed, expired)
 *        /test/seed                                       TEST makers rest a two-sided ladder on BTC-USDC and BTC-PERP
 *        /test/market-status {symbol,status}             the market's own state: trading|halted|cancel_only|delisted|null
 *        /test/market-limits {symbol,maxOrderQty,maxOrderNotional}   decimal strings, or null for "not reported"
 *        /test/market-add {symbol,baseAsset,quoteAsset,maxOrderQty,maxOrderNotional}   one more TEST cash spot market,
 *                                                         tick 0.1, lot 0.001, no ladder; refused if already listed
 *
 * TEST ONLY: `startTestVenueServer` refuses to start unless APP_ENV is exactly `dev` or `test`, and binds loopback.
 */

/**
 * The stack's TEST markets: BTC-USDC cash spot, the BTC-PERP perpetual (isolated margin only), and ETH-USDC cash spot
 * with no ladder (a market the venue lists that INTAFACED has not reviewed: J-cex-spot-16). Every market starts
 * `trading` with a TEST largest order. Figures are TEST.
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
    status: 'trading',
    // TEST: roomy enough for every journey's TEST orders on the shared BTC markets (J-cex-spot-01 #8 sells 100 BTC);
    // J-cex-spot-16 proves the venue's own caps on TEST markets of its own (/test/market-add, /test/market-limits).
    maxOrderQty: parseAmount('1000'),
    maxOrderNotional: parseAmount('100000000'),
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
];

/** The markets `seed` rests a ladder on (its prices are around a BTC mid). */
const LADDER_SYMBOLS: ReadonlySet<string> = new Set(['BTC-USDC', 'BTC-PERP']);
const MARKET_STATUSES: ReadonlySet<string> = new Set(['trading', 'halted', 'cancel_only', 'delisted']);

/** The ladder `seed` rests: around 60000, five levels a side, 10 apart, 1 BTC each. TEST. */
const SEED_MID = 60_000;
const SEED_LEVELS = 5;
const SEED_STEP = 10;
const SEED_SIZE = '1';

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

/**
 * Fund two TEST makers and rest a two-sided ladder on every market (one maker a side: the simulator offers opening
 * orders on one side of a perpetual per account). Idempotent: deposits by ref, orders by client key, so a second seed
 * adds nothing and a ladder level that was taken is not put back.
 */
export async function seedTestVenue(sim: TestVenueSimulator): Promise<{ makers: readonly string[]; orders: number }> {
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
      }
      for (let level = 1; level <= SEED_LEVELS; level += 1) {
        const price = side === 'bid' ? SEED_MID - level * SEED_STEP : SEED_MID + level * SEED_STEP;
        const clientOrderKey = `order:test-maker-${name}:seed:${market.symbol}:${level}`;
        if ((await sim.orderByClientId(acct, venueClientOrderId(sim.venue.id, clientOrderKey))).value) continue;
        const intent: PlaceUserOrderIntent = {
          kind: 'place_order',
          symbol: market.symbol,
          side: side === 'bid' ? 'buy' : 'sell',
          type: 'limit',
          amount: parseAmount(SEED_SIZE),
          price: parseAmount(String(price)),
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
    case '/preview':
      return sim.preview(account(body), body.intent as PlaceUserOrderIntent);
    case '/best-prices':
      return sim.bestPrices(str(body, 'symbol'));
    case '/prepare':
      return sim.prepare(account(body), body.signer as VenueSigner, body.intent as VenueIntent);
    case '/submit':
      return sim.submit(body.prepared as PreparedVenueAction, body.signature as VenueSignature);
    case '/balances':
      return sim.balances(account(body));
    case '/open-orders':
      return sim.openOrders(account(body));
    case '/positions':
      return sim.positions(account(body));
    case '/agents':
      return sim.agents(account(body));
    case '/order-by-client-id':
      return sim.orderByClientId(account(body), str(body, 'venueClientOrderId'));
    case '/fills': {
      const since = body.since;
      if (!(since instanceof Date)) throw new VenueWireError('since is required (an ISO time)');
      return sim.fills(account(body), since);
    }
    case '/withdrawal':
      return sim.withdrawal(account(body), str(body, 'nonce'));
    case '/builder-fee-approval':
      return sim.builderFeeApproval(account(body), str(body, 'builder'));
    case '/leverage':
      return sim.leverage(account(body), str(body, 'symbol'));
    // ── TEST controls ──
    case '/test/deposit': {
      const amount = body.amount;
      if (typeof amount !== 'bigint') throw new VenueWireError('amount is required (a decimal string)');
      return { credited: sim.deposit(account(body), str(body, 'asset'), amount as Amount, str(body, 'depositRef')), label: 'TEST' };
    }
    case '/test/switches': {
      if (typeof body.venueDown === 'boolean') sim.switches.venueDown = body.venueDown;
      if (typeof body.unlistPerpetuals === 'boolean') sim.switches.unlistPerpetuals = body.unlistPerpetuals;
      if (body.withdrawalFee !== undefined) sim.switches.withdrawalFee = maybeKnownAmount(body.withdrawalFee, 'withdrawalFee');
      if (body.networkFee !== undefined) sim.switches.networkFee = maybeKnownAmount(body.networkFee, 'networkFee');
      return {
        venueDown: sim.switches.venueDown,
        unlistPerpetuals: sim.switches.unlistPerpetuals,
        withdrawalFee: sim.switches.withdrawalFee,
        networkFee: sim.switches.networkFee,
        label: 'TEST',
      };
    }
    case '/test/settle-withdrawals':
      return { settled: sim.settleWithdrawals(), label: 'TEST' };
    case '/test/set-mark': {
      const price = body.price;
      if (typeof price !== 'bigint') throw new VenueWireError('price is required (a decimal string)');
      sim.setMark(str(body, 'symbol'), price as Amount);
      return { ok: true, label: 'TEST' };
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
  const sim = new TestVenueSimulator({ clock: opts.clock ?? (() => new Date()), markets: TEST_VENUE_MARKETS, chainId: opts.chainId });
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
