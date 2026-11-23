import fs from 'node:fs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type {
  AsOf,
  PlaceUserOrderIntent,
  PreparedVenueAction,
  UserVenue,
  UserVenueAccount,
  UserVenueFill,
  UserVenueMarket,
  UserVenueOrder,
  VenueSignature,
  VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { HL_TESTNET_VENUE_ID } from './core.js';
import { parseRecording, type HlRecording } from './recorded.js';

/**
 * ONE TEST ORDER ON THE HYPERLIQUID TEST NETWORK, RECORDED: a TEST account buys 0.001 BTC-PERP at most 70000 (IOC) and
 * the order fills. The recording (`recordings/order-btc-perp.json`) holds every answer the venue gave: the listing and
 * book captured from the live test network, and the order's answer, its status and its fill written to the venue's
 * documented shape (an order on the test network needs a funded test account; `scripts/record-order.ts` says how to
 * capture them live). Every figure is TEST.
 *
 * The scenario is one function over any `UserVenue`, so the recording replays the same requests whether the venue runs
 * in process (the recorder) or behind the HTTP venue protocol (svc-trade's test of the running venue).
 */

/** The recording's clock: every nonce and every time asked for is this instant. */
export const RECORDED_ORDER_NOW_MS = Date.UTC(2026, 10, 23, 12, 0, 0);

/** The TEST account's key, derived from a label so every run signs the same bytes. Never a real key; it holds nothing. */
export const recordedOrderKey = privateKeyToAccount(keccak256(toHex('intafaced TEST hl-recorded order owner')));

export const RECORDED_ORDER_ACCOUNT: UserVenueAccount = {
  venueId: HL_TESTNET_VENUE_ID,
  owner: recordedOrderKey.address.toLowerCase(),
  subAccount: null,
};

export const RECORDED_ORDER_INTENT: PlaceUserOrderIntent = {
  kind: 'place_order',
  symbol: 'BTC-PERP',
  side: 'buy',
  type: 'limit',
  amount: parseAmount('0.001'),
  price: parseAmount('70000'),
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: 'order:test-hl-recorded:desk:1',
  builderFee: null,
};

/** The recording, read from the package's `recordings/` folder (the same path from `src/` and `dist/`). */
export function loadOrderRecording(): HlRecording {
  const raw: unknown = JSON.parse(fs.readFileSync(new URL('../recordings/order-btc-perp.json', import.meta.url), 'utf8'));
  return parseRecording(raw);
}

/** The TEST key's signature over the prepared action's digest: the EIP-712 hash of the typed data `prepare` built. */
export async function signRecordedOrder(prepared: PreparedVenueAction): Promise<VenueSignature> {
  const signature = await recordedOrderKey.sign({ hash: `0x${prepared.digest.slice(2)}` });
  return { digest: prepared.digest, signature, signedBy: recordedOrderKey.address.toLowerCase() };
}

export interface RecordedOrderRun {
  readonly markets: AsOf<readonly UserVenueMarket[]>;
  readonly prepared: PreparedVenueAction;
  readonly outcome: VenueSubmitOutcome;
  readonly order: AsOf<UserVenueOrder | null>;
  readonly fills: AsOf<readonly UserVenueFill[]>;
}

type OrderVenue = Pick<UserVenue, 'markets' | 'prepare' | 'submit' | 'orderByClientId' | 'fills'>;

/** List the markets, prepare the order, sign it with the TEST key, submit it, and read its status and fills back. */
export async function runRecordedOrder(venue: OrderVenue): Promise<RecordedOrderRun> {
  const markets = await venue.markets(RECORDED_ORDER_ACCOUNT);
  const prepared = await venue.prepare(
    RECORDED_ORDER_ACCOUNT,
    { role: 'owner', address: RECORDED_ORDER_ACCOUNT.owner },
    RECORDED_ORDER_INTENT,
  );
  const outcome = await venue.submit(prepared, await signRecordedOrder(prepared));
  const cloid = prepared.venueClientOrderId;
  if (cloid === null) throw new Error('hl-recorded: a prepared order names its client order id');
  const order = await venue.orderByClientId(RECORDED_ORDER_ACCOUNT, cloid);
  const fills = await venue.fills(RECORDED_ORDER_ACCOUNT, new Date(RECORDED_ORDER_NOW_MS));
  return { markets, prepared, outcome, order, fills };
}
