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
  type VenueSubmitOutcome,
  type VenueTimeInForce,
} from '@intafaced/venue-contracts';
import {
  BPS_PER_X,
  PERP_COLLATERAL_ASSET,
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
import { HyperliquidReads } from './reads.js';
import {
  HL_SIGNATURE_CHAIN_ID,
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
} from './signing.js';
import { bpsToPercentString, bpsToTenths, priceProblem, rateToBps, sizeProblem, toWire } from './wire.js';

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
export { mapOrderStatus } from './reads.js';

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
 */
export function classifyVenueError(venueId: string, text: string, asOf: Date): VenueSubmitOutcome {
  if (/invalid nonce:\s*duplicate nonce/i.test(text)) return { definite: false, reason: 'already_submitted' };
  if (/cloid|client order id/i.test(text) && /duplicate|already/i.test(text)) return { definite: false, reason: 'already_submitted' };
  const code: VenueRefusalCode = /\bnonce\b/i.test(text)
    ? 'nonce_rejected'
    : /builder/i.test(text) && /approv|max(imum)? ?fee|exceed/i.test(text)
      ? 'builder_fee_not_approved'
      : /insufficient|not enough/i.test(text) && /margin|balance|funds/i.test(text)
        ? 'insufficient_balance'
        : /does not exist/i.test(text) && /user|wallet|agent|signer/i.test(text)
          ? 'signer_not_authorised'
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
      venueClientOrderId:
        intent.kind === 'place_order' || intent.kind === 'cancel_order' ? venueClientOrderId(this.venue.id, intent.clientOrderKey) : null,
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
    const l1 = (action: Record<string, MsgpackValue>): BuiltAction => ({
      action,
      vaultAddress: vault,
      typedData: l1TypedData(actionHash(action, vault, BigInt(nonce))),
    });
    const userSigned = (
      primaryType: UserSignedPrimaryType,
      type: string,
      fields: Record<string, string>,
      nonceField: 'time' | 'nonce',
    ): BuiltAction => {
      const action: Record<string, MsgpackValue> = {
        type,
        signatureChainId: HL_SIGNATURE_CHAIN_ID,
        hyperliquidChain: HL_TESTNET_CHAIN,
        ...fields,
        [nonceField]: Number(nonce),
      };
      const typedData = userSignedTypedData(primaryType, USER_SIGNED_TYPES[primaryType], {
        hyperliquidChain: HL_TESTNET_CHAIN,
        ...fields,
        [nonceField]: BigInt(nonce),
      });
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
        if (intent.validUntil !== null) {
          throw refusal(venueId, 'not_offered', 'an agent expiry is not offered by this adapter yet: approve without one');
        }
        if (intent.agentName.trim() === '')
          throw refusal(venueId, 'venue_rejected', 'an agent needs a name, so it can be listed and replaced');
        return userSigned(
          'HyperliquidTransaction:ApproveAgent',
          'approveAgent',
          { agentAddress: intent.agentAddress.toLowerCase(), agentName: intent.agentName },
          'nonce',
        );
      }
    }
  }

  private orderWire(m: HlMarket, intent: PlaceUserOrderIntent): Record<string, MsgpackValue> {
    const venueId = this.venue.id;
    if (intent.type === 'market' && intent.timeInForce === 'ALO')
      throw refusal(venueId, 'not_offered', 'a market order cannot be post-only');
    const sizeIssue = sizeProblem(intent.amount, m.szDecimals);
    if (sizeIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol}: ${sizeIssue}`);
    const priceIssue = priceProblem(intent.price, m.szDecimals, m.kind);
    if (priceIssue) throw refusal(venueId, 'venue_rejected', `${m.symbol}: ${priceIssue}`);
    // A market order is an IOC limit at the customer's worst price (the interface's rule, and the venue's own).
    const tif = intent.type === 'market' ? 'Ioc' : TIF_WIRE[intent.timeInForce];
    // Key order is the SDK's (order_request_to_order_wire): the hash depends on it.
    return {
      a: m.asset,
      b: intent.side === 'buy',
      p: toWire(intent.price),
      s: toWire(intent.amount),
      r: intent.reduceOnly,
      t: { limit: { tif } },
      c: venueClientOrderId(venueId, intent.clientOrderKey),
    };
  }

  // ── submit ─────────────────────────────────────────────────────────────

  async submit(prepared: PreparedVenueAction, signature: VenueSignature): Promise<VenueSubmitOutcome> {
    const venueId = this.venue.id;
    assertSignatureMatches(prepared, signature);
    this.checkAccount(prepared.account);
    assertSignerMaySign(prepared.account, prepared.signer, prepared.intent);
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

    const sent = await this.post(body);
    if (sent.kind === 'unknown') return { definite: false, reason: sent.reason };
    const asOf = this.clock();
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
  ): Promise<{ kind: 'json'; json: Json } | { kind: 'unknown'; reason: 'timeout' | 'connection_lost' | 'venue_error_after_send' }> {
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
    }
  }
}
