import { keccak256, toHex } from 'viem';
import { add, compare, div, min, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  assertSignatureMatches,
  assertSignerMaySign,
  venueClientOrderId,
  type AsOf,
  type MaybeKnown,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueOrder,
  type VenueAssetAmount,
  type VenueIntent,
  type VenueOrderPreview,
  type VenueRefusalCode,
  type VenueSignature,
  type VenueSigner,
  type VenueTrigger,
  type VenueSubmitOutcome,
  type VenueTimeInForce,
  type VenueLegOutcome,
} from '@intafaced/venue-contracts';
import {
  BPS_PER_X,
  HL_CANCELS_PER_ACTION,
  PERP_COLLATERAL_ASSET,
  PERP_QUOTE,
  WITHDRAW_DECIMALS,
  amt,
  arr,
  int,
  obj,
  refusal,
  str,
  type FetchLike,
  type HlMarket,
  type HyperliquidTestnetOptions,
  type Json,
} from './core.js';
import { assertSigningAgrees, SigningCrossCheckError } from './cross-check.js';
import type { MsgpackValue } from './msgpack.js';
import { NOT_OFFERED, isBuiltIntent } from './not-offered.js';
import { BUILDER_FEE_CAP_BPS } from './market-terms.js';
import { HyperliquidReads } from './reads.js';
import {
  HL_TESTNET_CHAIN,
  USER_SIGNED_TYPES,
  actionHash,
  l1TypedData,
  recoverTypedDataSigner,
  splitSignature,
  typedDataDigest,
  userSignedTypedData,
  type HlTypedData,
  type UserSignedPrimaryType,
  type UserSignedTypedData,
} from './signing.js';
import { bpsToPercentString, bpsToTenths, priceProblem, rateToBps, sizeProblem, toWire } from './wire.js';

/** "The expiration can be at most 180 days in the future." */
const AGENT_EXPIRY_MAX_MS = 180 * 24 * 60 * 60 * 1000;
/** Prepared typed data that approves an agent, as the wallet was asked to sign it. */
function isApproveAgentTypedData(typed: unknown): typed is UserSignedTypedData {
  return (
    typeof typed === 'object' &&
    typed !== null &&
    'primaryType' in typed &&
    typed.primaryType === 'HyperliquidTransaction:ApproveAgent' &&
    'domain' in typed &&
    'types' in typed &&
    'message' in typed &&
    typeof typed.message === 'object' &&
    typed.message !== null
  );
}

/** The expiry the venue reads off the end of an agent's name. */
const EXPIRY_IN_NAME = / valid_until \d+$/;
/** How long a revoke's keyless stand-in holds a named agent's slot before the venue prunes it. */
const REVOKE_STAND_IN_MS = 24 * 60 * 60 * 1000;

/** An address no one holds the key to (a hash, not a public key), new for each revoke: the agent that replaces a revoked one. */
export function keylessStandIn(revoked: string, nonce: string): string {
  return `0x${keccak256(toHex(`intafaced hyperliquid revoked agent ${revoked.toLowerCase()} ${nonce}`)).slice(-40)}`;
}

/**
 * THE HYPERLIQUID TESTNET `UserVenue` — the customer's own testnet account, signed by the customer's wallet.
 *
 * Proof level `partner-sandbox`: a TEST venue. Every figure from it is TEST,
 * and the constructor refuses it outside APP_ENV dev or test
 * (`refuseTestVenueOutsideTest`). The base URL and the chain are fixed to the
 * testnet; anything else is refused with `HyperliquidNetworkRefusedError`.
 *
 * Reads go to `POST /info`; signed actions to `POST /exchange`. `prepare`
 * builds the exact typed data the wallet signs (signing.ts) and sends nothing;
 * `submit` rebuilds the action from the prepared intent, checks the digest and
 * recovers the signer from the signature bytes, then posts.
 *
 * What the venue's answer means (`VenueSubmitOutcome`):
 *   · a timeout, a dropped connection, any HTTP status other than 2xx, or an
 *     unreadable body after the bytes went out → `definite: false` (read back
 *     by `prepared.venueClientOrderId` or `prepared.nonce`; never prepare
 *     again). The venue states its own refusals as HTTP 200 with
 *     `status: "err"` or a per-order `error`; a 4xx or 5xx may come from a
 *     proxy after the action was applied, so it is never read as a refusal;
 *   · the venue's "duplicate nonce" answer, and a duplicate cloid →
 *     `definite: false, reason: 'already_submitted'`;
 *   · any other nonce answer (too low, outside the time window) → a definite
 *     `nonce_rejected`: the venue did not apply this action;
 *   · a stated venue refusal → `definite: true, accepted: false` with a typed
 *     `VenueRefusalCode`.
 *
 * Symbols: a perpetual is `<COIN>-PERP` (quote USDC), a spot pair is
 * `<BASE>-<QUOTE>`, as the TEST simulator names them. Two venue markets never
 * share a symbol: when spot pairs share display names, the canonical pair (or
 * else the lowest-numbered one) keeps `<BASE>-<QUOTE>` and every other one is
 * `<BASE>-<QUOTE>@<pair index>`.
 */

// What this module exported before it was split (project-state #2655): importers of `./venue.js` are unchanged.
export {
  FILLS_GRID_MS,
  FILLS_PAGE_CAP,
  HL_TESTNET_VENUE_ID,
  InMemoryNonceSource,
  PERP_COLLATERAL_ASSET,
  type FetchLike,
  type HlBook,
  type HlBookLevel,
  type HyperliquidNonceSource,
  type HyperliquidTestnetOptions,
} from './core.js';
export { mapOrderStatus, withCancelReason } from './reads.js';

interface BuiltAction {
  readonly action: Record<string, MsgpackValue>;
  readonly typedData: HlTypedData;
  readonly vaultAddress: string | null;
}

const TIF_WIRE: Record<VenueTimeInForce, 'Gtc' | 'Ioc' | 'Alo'> = { GTC: 'Gtc', IOC: 'Ioc', ALO: 'Alo' };

/**
 * Map a venue's error text to a typed outcome. Matched on the venue's words,
 * which it does not version; every unmatched text is `venue_rejected` with the
 * text kept, never dropped.
 *
 * Nonces. The venue's documented rule (Hyperliquid docs, "Nonces and API
 * wallets"): it keeps the 100 highest nonces per signer, a new one must be
 * above the smallest of them and never used before, and within
 * (T - 2 days, T + 1 day) of the block time. The docs give no error text.
 * The wording below is what the venue has been seen to answer, from public
 * user reports, not from Hyperliquid's own docs or SDK:
 *   · "Invalid nonce: duplicate nonce <n>" — this nonce was already used, so
 *     this exact action may have landed: `already_submitted`, never definite;
 *   · "Invalid nonce: nonce too low ..." — below the kept set or the window.
 * The wording for a nonce too far in the future was not found in any public
 * source. Every nonce answer other than the duplicate one guarantees the
 * action was not applied, so it is a definite `nonce_rejected`.
 * "User has pending agent removal" answers an agent approval sent while the venue still removes an agent ended
 * moments before (seen on the test network): nothing applied, `agent_removal_pending`.
 */
export function classifyVenueError(venueId: string, text: string, asOf: Date): VenueSubmitOutcome {
  if (/invalid nonce:\s*duplicate nonce/i.test(text)) return { definite: false, reason: 'already_submitted' };
  if (/cloid|client order id/i.test(text) && /duplicate|already/i.test(text)) return { definite: false, reason: 'already_submitted' };
  const code: VenueRefusalCode = /\bnonce\b/i.test(text)
    ? 'nonce_rejected'
    : /pending agent removal/i.test(text)
      ? 'agent_removal_pending'
      : /builder/i.test(text) && /approv|max(imum)? ?fee|exceed/i.test(text)
        ? 'builder_fee_not_approved'
        : /insufficient|not enough/i.test(text) && /margin|balance|funds/i.test(text)
          ? 'insufficient_balance'
          : /does not exist/i.test(text) && /user|wallet|agent|signer/i.test(text)
            ? 'signer_not_authorised'
            : /cannot modify/i.test(text) && /canceled|cancelled|filled/i.test(text)
              ? 'order_final'
              : /never placed|already canceled|already cancelled/i.test(text)
                ? 'unknown_order'
                : /unknown asset|invalid asset|asset not found/i.test(text)
                  ? 'unknown_market'
                  : 'venue_rejected';
  return { definite: true, accepted: false, refusal: { venueId, code, detail: text }, asOf };
}

/** What the venue said about one order or cancel in an `ok` answer. */
type StatusLine = { kind: 'accepted'; venueRef: string | null } | { kind: 'error'; text: string };

function statusLine(response: Json): StatusLine {
  const r = obj(response, 'response');
  if (r.type === 'default') return { kind: 'accepted', venueRef: null };
  const data = obj(r.data, 'response.data');
  const statuses = arr(data.statuses, 'response.data.statuses');
  if (statuses.length !== 1) throw new Error(`venue answer: expected one status, got ${statuses.length}`);
  const s = statuses[0]!;
  if (typeof s === 'string') return { kind: 'accepted', venueRef: null }; // "success", "waitingForFill", "waitingForTrigger"
  const o = obj(s, 'status');
  if (typeof o.error === 'string') return { kind: 'error', text: o.error };
  const placed = (o.resting ?? o.filled) as Json | undefined;
  if (placed !== undefined) return { kind: 'accepted', venueRef: String(int(obj(placed, 'status.order').oid, 'oid')) };
  throw new Error('venue answer: an order status with neither resting, filled nor error');
}

/**
 * A batch cancel's answer (`cancelByCloid` with several cancels): one status per cancel, in the order sent. "success" is
 * that order cancelled; an error ("Order was never placed, already canceled, or filled.") is that order's own refusal,
 * and the rest still stand. A whole-action error refuses them all; an answer we cannot read is no answer.
 */
function cancelsOutcome(venueId: string, json: Json, { sent, asOf }: { readonly sent: number; readonly asOf: Date }): VenueSubmitOutcome {
  try {
    const answer = obj(json, 'exchange answer');
    if (answer.status === 'err') return classifyVenueError(venueId, str(answer.response, 'error text'), asOf);
    if (answer.status !== 'ok') return { definite: false, reason: 'venue_error_after_send' };
    const statuses = arr(obj(obj(answer.response ?? null, 'response').data, 'response.data').statuses, 'response.data.statuses');
    if (statuses.length !== sent) return { definite: false, reason: 'venue_error_after_send' };
    const legs = statuses.map((s): VenueLegOutcome => {
      if (s === 'success') return { definite: true, accepted: true, venueRef: null, order: null, asOf };
      const error = obj(s, 'status').error;
      if (typeof error !== 'string') throw new Error('venue answer: a cancel status with neither success nor error');
      const leg = classifyVenueError(venueId, error, asOf);
      // A cancel's own answer is never "already sent": one we cannot place is no answer for the batch.
      if (!leg.definite) throw new Error('venue answer: a cancel status that is not a definite answer');
      return leg;
    });
    return { definite: true, accepted: true, venueRef: null, order: null, legs, asOf };
  } catch {
    return { definite: false, reason: 'venue_error_after_send' };
  }
}

/**
 * A trigger order's condition (the Python SDK's `test_l1_action_signing_tpsl_order_matches`): the venue holds
 * it unseen until its mark price crosses `triggerPx`, then sends it as a market order bounded by `p` (`isMarket`) or a
 * limit at `p`. Hyperliquid judges every trigger on its mark price, closes with it only (a trigger here is
 * reduce-only, on a perpetual), and names a stop loss `sl` and a take profit `tp`. Anything else is refused before
 * signing, so no order goes out without its condition and trades at once.
 */
function triggerWire(
  venue: { readonly id: string; readonly displayName: string },
  m: HlMarket,
  intent: PlaceUserOrderIntent & { readonly trigger: VenueTrigger },
): Record<string, MsgpackValue> {
  const venueId = venue.id;
  const trigger = intent.trigger;
  if (m.kind !== 'perpetual') throw refusal(venueId, 'not_offered', `${m.symbol} is spot: a trigger order is offered on perpetuals only`);
  if (trigger.source !== 'mark')
    throw refusal(
      venueId,
      'not_offered',
      `${venue.displayName} judges a trigger order on its mark price only, not the ${trigger.source} price`,
    );
  if (!intent.reduceOnly) throw refusal(venueId, 'not_offered', 'a trigger order here only closes: it must be reduce-only');
  if (intent.type === 'limit' && intent.timeInForce !== 'GTC')
    throw refusal(venueId, 'not_offered', 'a triggered limit rests on the book until it fills: its time in force is GTC');
  const triggerIssue = priceProblem(trigger.price, m.szDecimals, m.kind);
  if (triggerIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol} trigger: ${triggerIssue}`);
  return { isMarket: intent.type === 'market', triggerPx: toWire(trigger.price), tpsl: trigger.role === 'take_profit' ? 'tp' : 'sl' };
}

/**
 * The signed side of the adapter: `preview`, `prepare` and `submit`. Its reads are `HyperliquidReads` (`reads.ts`), its
 * transport and listing `HyperliquidCore` (`core.ts`); an intent it does not build is in `not-offered.ts`, and a market
 * term it does not read in `market-terms.ts`. `venue-layout.test.ts` keeps each of those out of this file.
 */
export class HyperliquidTestnetUserVenue extends HyperliquidReads implements UserVenue {
  constructor(options: HyperliquidTestnetOptions) {
    super(options);
  }

  /**
   * What an order would lock and cost now, read from the venue (its book, the account's fee rates and leverage) with
   * nothing signed or sent. Refuses what `prepare` refuses on its face (lot and tick, post-only market).
   *
   * Our readings of the venue's rules, each to be confirmed on the live testnet run (project-state #1789):
   * - the lock: a spot buy holds its quote notional, a spot sell its base, a perp order its notional over the
   *   account's leverage (zero for reduce-only), as `openOrders` reports a resting order's lock;
   * - the fee asset: spot fees in the asset received, perp fees in the perp collateral; our builder fee in the same;
   * - the role: taker when the order meets the book's resting levels now or is IOC/market, maker otherwise.
   * The venue publishes no pre-trade liquidation price, so it is `known: false`.
   */
  async preview(account: UserVenueAccount, intent: PlaceUserOrderIntent): Promise<AsOf<VenueOrderPreview>> {
    this.checkAccount(account);
    const venueId = this.venue.id;
    if (intent?.kind !== 'place_order') throw refusal(venueId, 'not_offered', 'preview takes an order intent');
    const m = await this.market(intent.symbol);
    this.orderWire(m, intent);
    // A trigger order rests unseen until its price is crossed: what it would fill now is not what it will do.
    if (intent.trigger) throw refusal(venueId, 'not_offered', 'a trigger order is not previewed: it fills only once its price is crossed');
    const perp = m.kind === 'perpetual';
    if (!perp && intent.reduceOnly) throw refusal(venueId, 'not_offered', 'reduce-only is for perpetuals');

    const user = this.user(account);
    const [book, fees, assetData] = await Promise.all([
      this.info({ type: 'l2Book', coin: m.coin }),
      this.info({ type: 'userFees', user }),
      perp ? this.info({ type: 'activeAssetData', user, coin: m.coin }) : Promise.resolve(null),
    ]);

    // Walk the contra side's resting levels that cross the limit, best price first.
    const levels = arr(obj(book, 'l2Book').levels, 'l2Book levels');
    const contra = arr(levels[intent.side === 'buy' ? 1 : 0], 'l2Book side');
    const takes: Array<{ qty: Amount; price: Amount }> = [];
    let left = intent.amount;
    for (const raw of contra) {
      if (left === ZERO) break;
      const level = obj(raw, 'l2Book level');
      const price = amt(level.px, 'level px');
      const crosses = intent.side === 'buy' ? compare(price, intent.price) <= 0 : compare(price, intent.price) >= 0;
      if (!crosses) break;
      const qty = min(left, amt(level.sz, 'level sz'));
      takes.push({ qty, price });
      left = sub(left, qty);
    }
    const immediate = intent.type === 'market' || intent.timeInForce === 'IOC';
    const rests = left !== ZERO && !immediate ? left : ZERO;
    const role: 'maker' | 'taker' = takes.length > 0 || immediate ? 'taker' : 'maker';

    const feeRates = obj(fees, 'userFees');
    const rate = (field: string): MaybeKnown<Amount> =>
      typeof feeRates[field] === 'string' ? { known: true, value: rateToBps(feeRates[field]) } : { known: false };
    const taker = rate(perp ? 'userCrossRate' : 'userSpotCrossRate');
    const maker = rate(perp ? 'userAddRate' : 'userSpotAddRate');
    const feeInBase = !perp && intent.side === 'buy';
    const feeAsset = perp ? PERP_COLLATERAL_ASSET : feeInBase ? m.base : m.quote;
    const basisOf = (qty: Amount, price: Amount) => (feeInBase ? qty : mul(price, qty, 'ceil'));
    const bps = parseAmount(String(BPS_PER_X));
    const feeOn = (basis: Amount, rateBps: Amount) => div(mul(basis, rateBps, 'ceil'), bps, 'ceil');
    const line = (takerRate: MaybeKnown<Amount>, makerRate: MaybeKnown<Amount>): MaybeKnown<VenueAssetAmount> => {
      let total = ZERO;
      for (const t of takes) {
        if (!takerRate.known) return { known: false };
        total = add(total, feeOn(basisOf(t.qty, t.price), takerRate.value));
      }
      if (rests !== ZERO) {
        if (!makerRate.known) return { known: false };
        total = add(total, feeOn(basisOf(rests, intent.price), makerRate.value));
      }
      return { known: true, value: { asset: feeAsset, amount: total } };
    };
    // No builder fee on a spot buy: "builder codes do not apply to the buying side of spot trades" (Hyperliquid's
    // builder-codes page, read 9 Nov 2026; project-state #1888).
    const builderRate: MaybeKnown<Amount> = { known: true, value: intent.builderFee && !feeInBase ? intent.builderFee.feeBps : ZERO };

    let lock: VenueAssetAmount;
    let perpetual: VenueOrderPreview['perpetual'] = null;
    if (perp) {
      const data = obj(assetData, 'activeAssetData');
      if (!data.leverage) throw refusal(venueId, 'leverage_not_set', `${m.symbol}: the venue reports no leverage for this account`);
      const lev = obj(data.leverage, 'leverage');
      const leverageX = int(lev.value, 'leverage value');
      const initialMargin = intent.reduceOnly
        ? ZERO
        : div(mul(intent.price, intent.amount, 'ceil'), parseAmount(String(leverageX)), 'ceil');
      lock = { asset: PERP_COLLATERAL_ASSET, amount: initialMargin };
      perpetual = {
        leverageBps: leverageX * BPS_PER_X,
        marginMode: lev.type === 'isolated' ? 'isolated' : 'cross',
        initialMargin: { known: true, value: initialMargin },
        liquidationPrice: { known: false },
      };
    } else {
      lock =
        intent.side === 'buy'
          ? { asset: m.quote, amount: mul(intent.price, intent.amount, 'ceil') }
          : { asset: m.base, amount: intent.amount };
    }
    return this.asOf({
      symbol: m.symbol,
      kind: m.kind,
      lock,
      role,
      venueFee: line(taker, maker),
      builderFee: line(builderRate, builderRate),
      // The account's own rates from `userFees`, as the venue charges them now (J-cex-spot-10 #1).
      rates: { makerFeeBps: maker, takerFeeBps: taker },
      perpetual,
      // What would fill now needs a walk of the venue's book (l2Book) at this size; until it is read, not known.
      fill: { known: false },
    });
  }

  // ── prepare ────────────────────────────────────────────────────────────

  async prepare(account: UserVenueAccount, signer: VenueSigner, intent: VenueIntent): Promise<PreparedVenueAction> {
    this.checkAccount(account);
    assertSignerMaySign(account, signer, intent);
    if (signer.role === 'agent') {
      const now = this.clock().getTime();
      const agents = (await this.agents(account)).value;
      const live = agents.find(
        (a) => a.address === signer.address.toLowerCase() && (a.validUntil === null || a.validUntil.getTime() > now),
      );
      if (!live)
        throw refusal(
          this.venue.id,
          'signer_not_authorised',
          `${signer.address.toLowerCase()} is not an approved, unexpired agent on this account`,
        );
    }
    if (intent.kind === 'place_order' && intent.builderFee) {
      const cap = BUILDER_FEE_CAP_BPS[(await this.market(intent.symbol)).kind];
      if (compare(intent.builderFee.feeBps, cap) > 0) {
        throw refusal(this.venue.id, 'builder_fee_above_cap', `the builder fee is above the venue's cap on this market kind`);
      }
      const approved = (await this.builderFeeApproval(account, intent.builderFee.builder)).value;
      if (compare(approved, intent.builderFee.feeBps) < 0) {
        throw refusal(this.venue.id, 'builder_fee_not_approved', 'this account has approved less for the builder than the order carries');
      }
    }
    // Strictly increasing milliseconds near the clock, per signer: the venue keeps the highest nonces per signer and refuses a reused one.
    const nonce = await this.nonceSource.next(signer.address, this.clock().getTime());
    if (!/^\d+$/.test(nonce)) throw new Error(`nonce source returned ${nonce}, not a millisecond nonce`);
    const built = await this.build(account, intent, nonce);
    return {
      venueId: this.venue.id,
      account,
      signer,
      intent,
      nonce,
      // A move is read back by the client id the order holds after it: the replacement's own, or the amended order's.
      venueClientOrderId:
        intent.kind === 'place_order' || intent.kind === 'cancel_order'
          ? venueClientOrderId(this.venue.id, intent.clientOrderKey)
          : intent.kind === 'replace_order'
            ? venueClientOrderId(this.venue.id, intent.order.clientOrderKey)
            : intent.kind === 'amend_order'
              ? intent.venueClientOrderId
              : null,
      typedData: built.typedData,
      digest: typedDataDigest(built.typedData),
      builderFee:
        intent.kind === 'place_order' && intent.builderFee
          ? { builder: intent.builderFee.builder.toLowerCase(), feeBps: intent.builderFee.feeBps }
          : null,
      preparedAt: this.clock(),
    };
  }

  /** The exact action and typed data for `intent`. Deterministic from (account, intent, nonce) and the venue's listing. */
  /**
   * Builds the action and its typed data, then has `@nktkas/hyperliquid` build it again and refuses on any difference
   * (`cross-check.ts`). It runs at prepare and again at submit, which rebuilds from the intent.
   */
  private async build(account: UserVenueAccount, intent: VenueIntent, nonce: string): Promise<BuiltAction> {
    const built = await this.buildOwn(account, intent, nonce);
    try {
      await assertSigningAgrees({ action: built.action, vaultAddress: built.vaultAddress, nonce, typedData: built.typedData });
    } catch (error) {
      if (error instanceof SigningCrossCheckError) throw refusal(this.venue.id, 'signature_mismatch', error.message);
      throw error;
    }
    return built;
  }

  private async buildOwn(account: UserVenueAccount, intent: VenueIntent, nonce: string): Promise<BuiltAction> {
    const venueId = this.venue.id;
    const vault = account.subAccount ? account.subAccount.toLowerCase() : null;
    const signatureChainId = `0x${this.chainId.toString(16)}`;
    const l1 = (action: Record<string, MsgpackValue>): BuiltAction => ({
      action,
      vaultAddress: vault,
      typedData: l1TypedData(actionHash(action, vault, BigInt(nonce))),
    });
    const userSigned = (
      primaryType: UserSignedPrimaryType,
      type: string,
      fields: Record<string, string | boolean>,
      nonceField: 'time' | 'nonce',
    ): BuiltAction => {
      const action: Record<string, MsgpackValue> = {
        type,
        signatureChainId,
        hyperliquidChain: HL_TESTNET_CHAIN,
        ...fields,
        [nonceField]: Number(nonce),
      };
      const typedData = userSignedTypedData(
        primaryType,
        USER_SIGNED_TYPES[primaryType],
        { hyperliquidChain: HL_TESTNET_CHAIN, ...fields, [nonceField]: BigInt(nonce) },
        signatureChainId,
      );
      return { action, typedData, vaultAddress: null };
    };

    if (!isBuiltIntent(intent)) throw refusal(venueId, 'not_offered', NOT_OFFERED[intent.kind]);
    switch (intent.kind) {
      case 'place_order': {
        const m = await this.market(intent.symbol);
        const order = this.orderWire(m, intent);
        const action: Record<string, MsgpackValue> = { type: 'order', orders: [order], grouping: 'na' };
        if (intent.builderFee) {
          const f = bpsToTenths(intent.builderFee.feeBps);
          if (f === null || f < 0)
            throw refusal(venueId, 'not_offered', 'the builder fee must be a whole number of tenths of a basis point');
          action.builder = { b: intent.builderFee.builder.toLowerCase(), f };
        }
        return l1(action);
      }
      case 'cancel_order': {
        const m = await this.market(intent.symbol);
        return l1({ type: 'cancelByCloid', cancels: [{ asset: m.asset, cloid: venueClientOrderId(venueId, intent.clientOrderKey) }] });
      }
      case 'cancel_orders': {
        // Hyperliquid's own `cancelByCloid`, one entry per order, each named by the client id the venue holds: an order
        // this page or this stack did not place is cancelled too. The venue answers each in the order sent.
        const orders = Array.isArray(intent.orders) ? intent.orders : [];
        if (orders.length < 1) throw refusal(venueId, 'venue_rejected', 'a batch cancel names at least one order');
        if (orders.length > HL_CANCELS_PER_ACTION)
          throw refusal(venueId, 'not_offered', `this venue cancels at most ${HL_CANCELS_PER_ACTION} orders in one signed action`);
        const named = orders.map((o) => ({
          symbol: o?.symbol,
          cloid: typeof o?.venueClientOrderId === 'string' ? o.venueClientOrderId.toLowerCase() : '',
        }));
        const ids = named.map((n) => n.cloid);
        if (ids.some((id) => !/^0x[0-9a-f]{32}$/.test(id)))
          throw refusal(venueId, 'venue_rejected', "each order in a batch cancel is named by the venue's client id (0x and 32 hex digits)");
        if (new Set(ids).size !== ids.length) throw refusal(venueId, 'venue_rejected', 'each order in a batch cancel is named once');
        const cancels: MsgpackValue[] = [];
        for (const n of named) cancels.push({ asset: (await this.market(n.symbol)).asset, cloid: n.cloid });
        return l1({ type: 'cancelByCloid', cancels });
      }
      case 'replace_order': {
        // Hyperliquid's own `modify`: the venue cancels the resting order and places the replacement in one signed
        // action, so no moment passes with neither resting (a stop's position unprotected), as a cancel then a place
        // would leave. The `a` flag (place even when the cancel failed) is never set: a replacement whose original is
        // no longer resting is not placed (exchange endpoint, "Modify an order").
        const r = intent.order;
        if (r?.kind !== 'place_order') throw refusal(venueId, 'venue_rejected', 'a replacement is an order');
        if (r.symbol !== intent.symbol)
          throw refusal(venueId, 'venue_rejected', 'the replacement is on the market of the order it replaces');
        if (venueClientOrderId(venueId, r.clientOrderKey) === intent.venueClientOrderId)
          throw refusal(venueId, 'venue_rejected', 'the replacement has a client id of its own');
        if (r.type !== 'limit') throw refusal(venueId, 'not_offered', 'a replacement rests on the book: a limit order');
        if (r.trigger || r.parentClientOrderKey) throw refusal(venueId, 'not_offered', 'a trigger order is not placed as a replacement');
        // The venue's modify carries no builder field.
        if (r.builderFee) throw refusal(venueId, 'not_offered', 'a replacement carries no builder fee on this venue');
        const m = await this.market(r.symbol);
        return l1({ type: 'modify', oid: intent.venueClientOrderId, order: this.orderWire(m, r) });
      }
      case 'amend_order': {
        // The same `modify`, keeping the order's client id, side, reduce-only and time in force as the venue holds them.
        const m = await this.market(intent.symbol);
        const resting = (await this.orderByClientId(account, intent.venueClientOrderId)).value;
        if (resting === null || resting.status !== 'open' || resting.symbol !== intent.symbol)
          throw refusal(venueId, 'unknown_order', `no open order with client id ${intent.venueClientOrderId} on ${intent.symbol}`);
        const order: PlaceUserOrderIntent = {
          kind: 'place_order',
          symbol: intent.symbol,
          side: resting.side,
          type: 'limit',
          amount: intent.amount,
          price: intent.price,
          timeInForce: resting.timeInForce,
          reduceOnly: resting.reduceOnly,
          clientOrderKey: 'amend:unused',
          builderFee: null,
        };
        return l1({ type: 'modify', oid: intent.venueClientOrderId, order: { ...this.orderWire(m, order), c: intent.venueClientOrderId } });
      }
      case 'update_leverage': {
        const m = await this.market(intent.symbol);
        if (m.kind !== 'perpetual') throw refusal(venueId, 'not_offered', `${m.symbol} is spot: leverage is not offered`);
        if (!Number.isSafeInteger(intent.leverageBps) || intent.leverageBps % BPS_PER_X !== 0 || intent.leverageBps < BPS_PER_X) {
          throw refusal(venueId, 'not_offered', 'this venue takes whole leverage only (a multiple of 10000 bps, at least 1x)');
        }
        const leverage = intent.leverageBps / BPS_PER_X;
        if (m.maxLeverage !== null && leverage > m.maxLeverage)
          throw refusal(venueId, 'not_offered', `${m.symbol} offers at most ${m.maxLeverage}x`);
        if (intent.marginMode === 'cross' && m.onlyIsolated)
          throw refusal(venueId, 'not_offered', `${m.symbol} offers isolated margin only`);
        return l1({ type: 'updateLeverage', asset: m.asset, isCross: intent.marginMode === 'cross', leverage });
      }
      case 'withdraw': {
        if (account.subAccount !== null)
          throw refusal(venueId, 'not_offered', 'a withdrawal from a sub-account is not offered: move the funds to the main account first');
        // withdraw3 draws on the perpetual account's USDC, which balances() reports as USDC-PERP. Spot USDC is a different balance.
        if (intent.asset !== PERP_COLLATERAL_ASSET) {
          throw refusal(
            venueId,
            'not_offered',
            `only ${PERP_COLLATERAL_ASSET} (the perpetual account's USDC) can be withdrawn here; move spot funds to the perpetual account first`,
          );
        }
        if (compare(intent.amount, ZERO) <= 0) throw refusal(venueId, 'venue_rejected', 'a withdrawal must be positive');
        const problem = sizeProblem(intent.amount, WITHDRAW_DECIMALS);
        if (problem) throw refusal(venueId, 'venue_rejected', `withdrawal: ${problem}`);
        return userSigned(
          'HyperliquidTransaction:Withdraw',
          'withdraw3',
          { destination: intent.destination.toLowerCase(), amount: toWire(intent.amount) },
          'time',
        );
      }
      case 'spot_perps_transfer': {
        // The venue's `usdClassTransfer` (J-derivatives-29 #2): USDC between this account's own spot and perps balances,
        // signed by the owner's wallet. The venue's sub-account form (" subaccount:<address>" in the amount) is not built.
        if (account.subAccount !== null)
          throw refusal(venueId, 'not_offered', 'a move between spot and perps on a sub-account is not offered by this adapter yet');
        if (intent.asset !== PERP_QUOTE) throw refusal(venueId, 'venue_rejected', `only ${PERP_QUOTE} moves between spot and perps`);
        if (compare(intent.amount, ZERO) <= 0) throw refusal(venueId, 'venue_rejected', 'a move must be positive');
        const problem = sizeProblem(intent.amount, WITHDRAW_DECIMALS);
        if (problem) throw refusal(venueId, 'venue_rejected', `move: ${problem}`);
        const { mode } = (await this.accountMode(account)).value;
        if (mode !== 'standard')
          throw refusal(
            venueId,
            'venue_rejected',
            mode === null
              ? 'the account mode is not known, so a move between spot and perps is refused'
              : `the account is in ${mode} mode, which holds one balance for each asset: there is nothing to move between spot and perps`,
          );
        return userSigned(
          'HyperliquidTransaction:UsdClassTransfer',
          'usdClassTransfer',
          { amount: toWire(intent.amount), toPerp: intent.direction === 'spot_to_perps' },
          'nonce',
        );
      }
      case 'approve_builder_fee': {
        const f = bpsToTenths(intent.maxFeeBps);
        if (f === null || f < 0)
          throw refusal(venueId, 'not_offered', 'the builder fee approval must be a whole number of tenths of a basis point');
        return userSigned(
          'HyperliquidTransaction:ApproveBuilderFee',
          'approveBuilderFee',
          { maxFeeRate: bpsToPercentString(intent.maxFeeBps), builder: intent.builder.toLowerCase() },
          'nonce',
        );
      }
      case 'approve_agent': {
        const name = intent.agentName;
        if (name.trim() === '') throw refusal(venueId, 'venue_rejected', 'an agent needs a name, so it can be listed and replaced');
        // The venue reads an expiry out of the name, so a name never carries one of its own.
        if (EXPIRY_IN_NAME.test(name)) throw refusal(venueId, 'venue_rejected', 'an agent name cannot end in "valid_until <ms>"');
        let wireName = name;
        if (intent.validUntil !== null) {
          // The venue takes an expiry only in the name: `<name> valid_until <ms>`, at most 180 days ahead
          // (exchange endpoint, "Approve an API wallet"). Checked against the nonce, so a rebuild at submit agrees.
          const until = intent.validUntil.getTime();
          const at = Number(nonce);
          if (!Number.isSafeInteger(until) || until <= at)
            throw refusal(venueId, 'venue_rejected', 'an agent expiry must be ahead of the approval');
          if (until - at > AGENT_EXPIRY_MAX_MS)
            throw refusal(venueId, 'not_offered', 'an agent expiry is at most 180 days ahead on this venue');
          wireName = `${name} valid_until ${until}`;
        }
        return userSigned(
          'HyperliquidTransaction:ApproveAgent',
          'approveAgent',
          { agentAddress: intent.agentAddress.toLowerCase(), agentName: wireName },
          'nonce',
        );
      }
      case 'revoke_agent': {
        // The venue has no revoke. An agent is deregistered when another is approved under its name (the account's one
        // unnamed agent by another unnamed one) ("Nonces and API wallets"). So a revoke approves, under the agent's own
        // name, an address nobody holds a key for: derived from the revoked address and this nonce, so it is new every
        // time and never approved again. A named stand-in lapses a day later and frees its slot.
        // The venue lists agents per owner: a revoke asked for a sub-account could not be checked against its scope.
        if (account.subAccount !== null)
          throw refusal(venueId, 'not_offered', 'revoking an agent on a sub-account is not offered by this adapter yet');
        const address = intent.agentAddress.toLowerCase();
        const listed = (await this.agents(account)).value.find((a) => a.address === address);
        if (!listed) throw refusal(venueId, 'venue_rejected', `${address} is not an agent on this account: there is nothing to revoke`);
        const name = listed.name.replace(EXPIRY_IN_NAME, '');
        return userSigned(
          'HyperliquidTransaction:ApproveAgent',
          'approveAgent',
          {
            agentAddress: keylessStandIn(address, nonce),
            agentName: name === '' ? '' : `${name} valid_until ${Number(nonce) + REVOKE_STAND_IN_MS}`,
          },
          'nonce',
        );
      }
    }
  }

  private orderWire(m: HlMarket, intent: PlaceUserOrderIntent): Record<string, MsgpackValue> {
    const venueId = this.venue.id;
    if (intent.type === 'market' && intent.timeInForce === 'ALO')
      throw refusal(venueId, 'not_offered', 'a market order cannot be post-only');
    // An order attached to an entry needs the venue's `normalTpsl` grouping, not built here: sent alone it would arm on
    // nothing the entry filled. Refused, never sent without its link.
    if (intent.parentClientOrderKey)
      throw refusal(venueId, 'not_offered', 'an order attached to an entry is not offered on this venue yet');
    const sizeIssue = sizeProblem(intent.amount, m.szDecimals);
    if (sizeIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol}: ${sizeIssue}`);
    const priceIssue = priceProblem(intent.price, m.szDecimals, m.kind);
    if (priceIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol}: ${priceIssue}`);
    // Key order is the SDK's (order_request_to_order_wire, order_type_to_wire): the hash depends on it.
    return {
      a: m.asset,
      b: intent.side === 'buy',
      p: toWire(intent.price),
      s: toWire(intent.amount),
      r: intent.reduceOnly,
      t: intent.trigger
        ? { trigger: triggerWire(this.venue, m, { ...intent, trigger: intent.trigger }) }
        : { limit: { tif: intent.type === 'market' ? 'Ioc' : TIF_WIRE[intent.timeInForce] } },
      c: venueClientOrderId(venueId, intent.clientOrderKey),
    };
  }

  // ── submit ─────────────────────────────────────────────────────────────

  async submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> {
    const venueId = this.venue.id;
    assertSignatureMatches(prepared, signature);
    this.checkAccount(prepared.account);
    assertSignerMaySign(prepared.account, prepared.signer, prepared.intent);
    if (prepared.intent.kind === 'revoke_agent') {
      // A revoke sent again after it landed: its stand-in, which only this signed action approves, is listed. Once the
      // owner's signature over that approval checks out, it is done, and nothing is posted twice.
      const standIn = keylessStandIn(prepared.intent.agentAddress, prepared.nonce);
      const agents = await this.agents(prepared.account);
      if (agents.value.some((a) => a.address === standIn)) {
        const typed = prepared.typedData;
        if (
          !isApproveAgentTypedData(typed) ||
          String(typed.message.agentAddress).toLowerCase() !== standIn ||
          String(typed.message.nonce) !== prepared.nonce ||
          typedDataDigest(typed).toLowerCase() !== prepared.digest.toLowerCase() ||
          (await recoverTypedDataSigner(typed, signature.signature)) !== prepared.signer.address.toLowerCase()
        ) {
          throw refusal(venueId, 'signature_mismatch', 'the prepared revoke does not match the approval that replaced the agent');
        }
        return { definite: true, accepted: true, venueRef: null, order: null, asOf: agents.asOf };
      }
    }
    // Rebuild from the intent: the prepared object may have been edited after prepare.
    const built = await this.build(prepared.account, prepared.intent, prepared.nonce);
    const digest = typedDataDigest(built.typedData);
    if (digest.toLowerCase() !== prepared.digest.toLowerCase()) {
      throw refusal(venueId, 'signature_mismatch', 'the prepared action does not match its own digest');
    }
    const recovered = await recoverTypedDataSigner(built.typedData, signature.signature);
    if (recovered !== prepared.signer.address.toLowerCase()) {
      throw refusal(
        venueId,
        'signature_mismatch',
        `the signature was made by ${recovered ?? 'no valid key'}, not ${prepared.signer.address.toLowerCase()}`,
      );
    }
    const body = JSON.stringify({
      action: built.action,
      nonce: Number(prepared.nonce),
      signature: splitSignature(signature.signature),
      vaultAddress: built.vaultAddress,
      expiresAfter: null,
    });
    if (prepared.intent.kind === 'withdraw') this.withdrawalDestinations.set(prepared.nonce, prepared.intent.destination.toLowerCase());

    const accounts = [prepared.account.owner, prepared.account.subAccount, built.vaultAddress].filter(
      (a): a is string => typeof a === 'string' && a !== '',
    );
    // The venue weighs an action 1, plus 1 per 40 orders or cancels it carries.
    const batch = [built.action.orders, built.action.cancels].reduce<number>((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
    this.spend(`exchange:${String(built.action.type)}`, 1 + Math.floor(batch / 40));
    const sent = await this.post(body, accounts, String(built.action.type));
    if (sent.kind === 'unknown') return { definite: false, reason: sent.reason };
    const asOf = this.clock();
    if (prepared.intent.kind === 'cancel_orders') return cancelsOutcome(venueId, sent.json, { sent: prepared.intent.orders.length, asOf });
    let line: StatusLine;
    try {
      const answer = obj(sent.json, 'exchange answer');
      if (answer.status === 'err') line = { kind: 'error', text: str(answer.response, 'error text') };
      else if (answer.status === 'ok') line = statusLine(answer.response ?? null);
      else return { definite: false, reason: 'venue_error_after_send' };
    } catch {
      // An answer we cannot read after the bytes went out is not an answer.
      return { definite: false, reason: 'venue_error_after_send' };
    }
    return this.outcomeOf(prepared, line, asOf);
  }

  private async outcomeOf(prepared: PreparedVenueAction, line: StatusLine, asOf: Date): Promise<VenueSubmitOutcome> {
    const venueId = this.venue.id;
    const intent = prepared.intent;
    if (intent.kind === 'cancel_order') {
      // A repeat cancel, or a cancel of an order already gone: the venue's record of the order is the answer.
      if (line.kind === 'accepted' || /never placed|already canceled|already cancelled|filled/i.test(line.text)) {
        let order: UserVenueOrder | null;
        try {
          order = (await this.orderByClientId(prepared.account, prepared.venueClientOrderId!)).value;
        } catch {
          if (line.kind === 'accepted') return { definite: true, accepted: true, venueRef: null, order: null, asOf };
          return { definite: true, accepted: false, refusal: { venueId, code: 'venue_rejected', detail: line.text }, asOf };
        }
        if (order === null) {
          // The venue said success: that wins. A read that finds nothing yet is "not found yet", never a refusal.
          if (line.kind === 'accepted') return { definite: true, accepted: true, venueRef: null, order: null, asOf };
          return {
            definite: true,
            accepted: false,
            refusal: { venueId, code: 'unknown_order', detail: 'no order with this client id on the venue' },
            asOf,
          };
        }
        if (order.status === 'canceled') return { definite: true, accepted: true, venueRef: order.venueOrderId, order, asOf };
        // The venue said success, but its record still lists the order live: the read lags the cancel. Never hand
        // that back as the answer, which would read "Open" after Cancel; the next read of the venue has the detail.
        if (line.kind === 'accepted' && (order.status === 'open' || order.status === 'partially_filled'))
          return { definite: true, accepted: true, venueRef: order.venueOrderId, order: null, asOf };
        if (line.kind === 'accepted') return { definite: true, accepted: true, venueRef: order.venueOrderId, order, asOf };
        return {
          definite: true,
          accepted: false,
          refusal: { venueId, code: 'order_final', detail: `the order is already ${order.status}` },
          asOf,
        };
      }
      return classifyVenueError(venueId, line.text, asOf);
    }
    if (line.kind === 'error') return classifyVenueError(venueId, line.text, asOf);
    if (intent.kind === 'replace_order' || intent.kind === 'amend_order') {
      // The venue took the one modify: the original was cancelled and the order now rests as changed. Its record is read
      // back by the client id it holds now; a read that finds nothing yet leaves the detail to the next read.
      let order: UserVenueOrder | null = null;
      const changedId = prepared.venueClientOrderId;
      try {
        if (changedId !== null) order = (await this.orderByClientId(prepared.account, changedId)).value;
      } catch {
        order = null;
      }
      const venueRef = order?.venueOrderId ?? null;
      if (intent.kind === 'amend_order') return { definite: true, accepted: true, venueRef, order, asOf };
      return {
        definite: true,
        accepted: true,
        venueRef,
        order,
        legs: [
          { definite: true, accepted: true, venueRef: null, order: null, asOf },
          { definite: true, accepted: true, venueRef, order, asOf },
        ],
        asOf,
      };
    }
    let order: UserVenueOrder | null = null;
    if (intent.kind === 'place_order') {
      try {
        order = (await this.orderByClientId(prepared.account, prepared.venueClientOrderId!)).value;
      } catch {
        order = null; // accepted is definite; the order's detail is read back later
      }
    }
    return { definite: true, accepted: true, venueRef: line.venueRef, order, asOf };
  }

  private async post(
    body: string,
    accounts: readonly string[],
    actionType: string,
  ): Promise<{ kind: 'json'; json: Json } | { kind: 'unknown'; reason: 'timeout' | 'connection_lost' | 'venue_error_after_send' }> {
    // A signed action changes what its own accounts read (an order, a builder approval, a new session key): what was kept
    // of them is dropped before it is sent, and again once the venue answers, so a read made while it was in flight is not kept.
    this.forgetReads(accounts, actionType);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        return {
          kind: 'unknown',
          reason: controller.signal.aborted || (error as Error).name === 'AbortError' ? 'timeout' : 'connection_lost',
        };
      }
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        return {
          kind: 'unknown',
          reason: controller.signal.aborted || (error as Error).name === 'AbortError' ? 'timeout' : 'connection_lost',
        };
      }
      // The venue states its refusals as HTTP 200 (`status: "err"`, or an `error` per order). Any other status after the bytes
      // went out (a proxy's 403, 408 or 409, a 429, a 5xx) may follow an applied action, and nothing here proves a 429 came
      // before the action reached the venue: never a refusal, always a read-back.
      if (!res.ok) return { kind: 'unknown', reason: 'venue_error_after_send' };
      try {
        return { kind: 'json', json: JSON.parse(text) as Json };
      } catch {
        return { kind: 'unknown', reason: 'venue_error_after_send' };
      }
    } finally {
      clearTimeout(timer);
      this.forgetReads(accounts, actionType);
    }
  }
}
