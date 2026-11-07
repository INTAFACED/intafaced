/**
 * WALLET ORDERS (D-limit-dca-01 to -04): the person's own price, take-profit and stop, bracket and trailing orders,
 * signed by their wallet, held off chain until they fill, and filled by the keeper from their own vault credit.
 *
 * Every call takes the maker from the order session (`auth/order-session.ts`), never from an address the caller names.
 * This process builds what the wallet signs and the unsigned calls the wallet sends (deposit, withdraw, cancel, replace);
 * it never signs for the person and never moves their funds. Owner bounds that are blank refuse by name.
 */

import { randomBytes } from 'node:crypto';
import { SCALE } from '@intafaced/ledger-client/money';
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  hashTypedData,
  keccak256,
  encodeAbiParameters,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import type { OrderPrincipal } from '../auth/order-session.js';
import { ERC20_ABI, ORDER_DOMAIN_NAME, ORDER_DOMAIN_VERSION, ORDER_TYPES, ORDER_VAULT_ABI } from './abi.js';
import type { VaultChain } from './chain.js';
import { refuse, vaultCodes } from './errors.js';
import { FINAL_STATES, ZERO32, type ChainOrder, type OrderKind, type OrderPair, type WalletOrder, type WalletOrderState } from './model.js';
import type { WalletOrderStore } from './store.js';

export const RESTING_COPY =
  'Your resting order is held by the platform keeper and is not visible on chain until it fills. The vault funds are on chain.';
export const RATE_COPY = 'Output is not a guaranteed fixed rate: each fill pays at least its share of the minimum output.';
export const CANCEL_COPY = 'Cancelled orders stop filling at once. Your funds return when you sign the withdrawal.';

const WAD = SCALE;
const BPS = 10_000n;
const DRAFT_TTL_MS = 10 * 60 * 1000;
export const PAGE_SIZE = 100;

export interface WalletOrderSettings {
  readonly pairs: readonly OrderPair[] | undefined;
  /** Scaled to 18 decimals, in the base token. */
  readonly minSize: bigint | undefined;
  readonly slippageBps: number | undefined;
  readonly restrictedTokens: readonly string[] | undefined;
  readonly trailBounds: { readonly min: number; readonly max: number } | undefined;
}

export type CreateKind = 'sell_above' | 'sell_below' | 'buy_above' | 'buy_below' | 'take_profit_and_stop' | 'bracket' | 'trailing_stop';

export interface CreateInput {
  readonly kind: CreateKind;
  readonly side: 'buy' | 'sell';
  /** In whole base tokens, a decimal string. */
  readonly amount: string;
  readonly trigger?: string;
  readonly takeProfit?: string;
  readonly stop?: string;
  readonly trailPercent?: string;
  /** Hours from now, a decimal string. */
  readonly expiryHours?: string;
}

export interface UnsignedCall {
  readonly label: string;
  readonly to: Address;
  readonly data: Hex;
}

interface Draft {
  readonly id: string;
  readonly wallet: string;
  readonly expiresAt: number;
  readonly rows: readonly { kind: OrderKind; order: ChainOrder; amountBase: bigint; siblings: Hex[]; parentId: Hex | null }[];
  /** An edit replaces one stored order. */
  readonly editOf?: Hex;
}

// ── Formatting ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Smallest units to a plain decimal string, trailing zeros dropped. */
export const amountText = (units: bigint, decimals: number) => {
  const s = formatUnits(units, decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};
/** A 1e18-scaled price, at least two and at most six decimals ("1.30", "0.8075"). */
const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
  roundingMode: 'trunc',
  useGrouping: false,
});
export function priceText(wad: bigint): string {
  // A decimal string keeps every digit: Intl formats it exactly, cutting (never rounding) past six decimals.
  return PRICE_FORMAT.format(formatUnits(wad, 18) as `${number}`);
}
const parseDecimal = (raw: string | undefined, decimals: number, code: (typeof vaultCodes)[keyof typeof vaultCodes], what: string) => {
  const text = (raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return refuse(code, `${what} must be a positive decimal number`);
  const [, frac = ''] = text.split('.');
  if (frac.length > decimals) return refuse(code, `${what} has more than ${decimals} decimal places`);
  const units = parseUnits(text, decimals);
  if (units <= 0n) return refuse(code, `${what} must be more than zero`);
  return units;
};

const kindName: Record<OrderKind, string> = {
  sell_above: 'Sell above',
  sell_below: 'Sell below',
  buy_above: 'Buy above',
  buy_below: 'Buy below',
  take_profit: 'Take-profit',
  stop: 'Stop',
  bracket: 'Bracket',
  bracket_take_profit: 'Bracket take-profit',
  bracket_stop: 'Bracket stop',
  trailing_stop: 'Trailing stop',
};

export class WalletOrders {
  private readonly drafts = new Map<string, Draft>();

  constructor(
    private readonly store: WalletOrderStore,
    private readonly chain: VaultChain,
    private readonly settings: WalletOrderSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private pair(): OrderPair {
    const pair = this.settings.pairs?.[0];
    if (!pair) return refuse(vaultCodes.pairUnset, 'No order pair is published, so no order can be placed.');
    return pair;
  }

  private wired(): void {
    if (!this.chain.wired || !this.chain.vault)
      refuse(vaultCodes.railCrypto, 'The order vault needs a chain node. It is switched off in this build.');
  }

  private token(address: string | undefined) {
    const pair = this.pair();
    const want = (address ?? pair.base.address).toLowerCase();
    const found = [pair.base, pair.quote].find((t) => t.address.toLowerCase() === want);
    if (!found) return refuse(vaultCodes.badRequest, 'That token is not one this vault trades.');
    return found;
  }

  domain() {
    this.wired();
    return { name: ORDER_DOMAIN_NAME, version: ORDER_DOMAIN_VERSION, chainId: this.chain.chainId, verifyingContract: this.chain.vault! };
  }

  /** The EIP-712 document the wallet signs for one order. Amounts travel as decimal strings. */
  typedData(order: ChainOrder) {
    const d = this.domain();
    return {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...ORDER_TYPES,
      } as unknown as Record<string, { name: string; type: string }[]>,
      primaryType: 'Order',
      domain: d,
      message: {
        ...order,
        amountIn: order.amountIn.toString(),
        triggerWad: order.triggerWad.toString(),
        trailBps: order.trailBps.toString(),
        minOut: order.minOut.toString(),
        expiry: order.expiry.toString(),
        nonce: order.nonce.toString(),
        version: order.version.toString(),
      } as Record<string, unknown>,
    };
  }

  orderId(maker: string, nonce: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(maker), nonce])).toLowerCase() as Hex;
  }

  // ── The vault ─────────────────────────────────────────────────────────────────────────────────────────────────

  async vault(wallet: string, tokenAddress?: string) {
    this.wired();
    const token = this.token(tokenAddress);
    const [credit, strays] = await Promise.all([this.chain.credit(wallet, token.address), this.chain.strays(wallet, token.address)]);
    return {
      vault: this.chain.vault!,
      token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
      tokens: [this.pair().base, this.pair().quote].map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals })),
      credit: amountText(credit, token.decimals),
      strays: amountText(strays, token.decimals),
    };
  }

  async depositCalls(wallet: string, tokenAddress: string, amount: string): Promise<UnsignedCall[]> {
    this.wired();
    const token = this.token(tokenAddress);
    const units = parseDecimal(amount, token.decimals, vaultCodes.amountInvalid, 'The deposit amount');
    const vault = this.chain.vault!;
    return [
      {
        label: `Allow the order vault to take ${amount} ${token.symbol}`,
        to: token.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [vault, units] }),
      },
      {
        label: `Deposit ${amount} ${token.symbol} into your order vault credit`,
        to: vault,
        data: encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'deposit', args: [token.address, units] }),
      },
    ];
  }

  /** The whole credit of one token back to the wallet: the call the wallet signs, and how much it returns. */
  async withdrawCall(wallet: string, tokenAddress?: string) {
    this.wired();
    const token = this.token(tokenAddress);
    const credit = await this.chain.credit(wallet, token.address);
    if (credit === 0n) return refuse(vaultCodes.nothingToWithdraw, 'There is no credit of this token in your order vault.');
    return {
      amount: amountText(credit, token.decimals),
      symbol: token.symbol,
      call: {
        label: `Withdraw ${amountText(credit, token.decimals)} ${token.symbol} to your wallet`,
        to: this.chain.vault!,
        data: encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'withdraw', args: [token.address, credit] }),
      } satisfies UnsignedCall,
    };
  }

  /** The keeper returns tokens this wallet sent the vault by a plain transfer, to this wallet only. */
  async sweep(wallet: string, tokenAddress?: string) {
    this.wired();
    const token = this.token(tokenAddress);
    const strays = await this.chain.strays(wallet, token.address);
    if (strays === 0n) return refuse(vaultCodes.nothingToSweep, 'No tokens from this wallet are waiting in the vault uncredited.');
    const to = getAddress(wallet);
    const txHash = await this.chain.sendSweep(token.address, to, strays);
    for (let i = 0; i < 30; i += 1) {
      const r = await this.chain.receipt(txHash);
      if (r.status === 'success') return { returned: amountText(strays, token.decimals), symbol: token.symbol, to, txHash };
      if (r.status === 'reverted') return refuse(vaultCodes.internal, 'The return of stray tokens reverted. Nothing moved.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { returned: amountText(strays, token.decimals), symbol: token.symbol, to, txHash, pending: true };
  }

  // ── Placing ───────────────────────────────────────────────────────────────────────────────────────────────────

  private slippage(): bigint {
    if (this.settings.slippageBps === undefined) return refuse(vaultCodes.slippageUnset, 'The order slippage default is not published.');
    return BigInt(this.settings.slippageBps);
  }

  private checkRestricted(pair: OrderPair): void {
    const list = this.settings.restrictedTokens;
    if (list === undefined) refuse(vaultCodes.restrictedListUnset, 'The restricted token list is not published.');
    for (const t of [pair.base, pair.quote])
      if (list!.includes(t.address.toLowerCase())) refuse(vaultCodes.restrictedToken, `${t.symbol} may not be traded here.`);
  }

  private checkSize(amount: string, pair: OrderPair): void {
    if (this.settings.minSize === undefined) refuse(vaultCodes.minSizeUnset, 'The minimum order size is not published.');
    if (parseUnits(amount.trim(), 18) < this.settings.minSize!)
      refuse(
        vaultCodes.belowMinSize,
        `The order is below the minimum size of ${amountText(this.settings.minSize!, 18)} ${pair.base.symbol}.`,
      );
  }

  /** What one whole-base price buys of the output, scaled: sells give quote, buys give base. */
  private sellMinOut(amountBase: bigint, priceWad: bigint, pair: OrderPair, slip: bigint): bigint {
    const quoteUnits = (amountBase * priceWad * 10n ** BigInt(pair.quote.decimals)) / (WAD * 10n ** BigInt(pair.base.decimals));
    return (quoteUnits * (BPS - slip)) / BPS;
  }
  private buySpend(amountBase: bigint, priceWad: bigint, pair: OrderPair): bigint {
    return (amountBase * priceWad * 10n ** BigInt(pair.quote.decimals)) / (WAD * 10n ** BigInt(pair.base.decimals));
  }

  private async capCheck(principal: OrderPrincipal, token: Address, adding: bigint, decimals: number): Promise<void> {
    const cap = principal.cap.find((c) => c.token.toLowerCase() === token.toLowerCase());
    if (!cap) return refuse(vaultCodes.capExceeded, 'Your order session has no cap for this token.');
    const open = this.store
      .byMaker(principal.wallet)
      .filter(
        (row) => !FINAL_STATES.has(row.state) && row.order.parent === ZERO32 && tokenIn(row.order).toLowerCase() === token.toLowerCase(),
      )
      .reduce((sum, row) => sum + (row.order.amountIn - row.filledIn), 0n);
    if (open + adding > parseUnits(cap.max, decimals))
      refuse(
        vaultCodes.capExceeded,
        `This order would keep more than ${cap.max} ${cap.symbol} open, the cap your order session was signed for.`,
      );
  }

  async prepare(principal: OrderPrincipal, input: CreateInput) {
    this.wired();
    const pair = this.pair();
    this.checkRestricted(pair);
    const slip = this.slippage();
    const amount = parseDecimal(input.amount, pair.base.decimals, vaultCodes.amountInvalid, 'The amount');
    this.checkSize(input.amount, pair);
    if (input.expiryHours === undefined || input.expiryHours.trim() === '')
      refuse(vaultCodes.expiryRequired, 'A price order needs an expiry.');
    const hours = parseDecimal(input.expiryHours, 6, vaultCodes.expiryInvalid, 'The expiry');
    const chainNow = await this.chain.now();
    const expiry = chainNow + (hours * 3600n) / 1_000_000n;
    if (expiry <= chainNow) refuse(vaultCodes.expiryInvalid, 'The expiry must be later than now.');
    const maker = getAddress(principal.wallet);
    const fresh = (): bigint => BigInt(`0x${randomBytes(8).toString('hex')}`);
    const base = {
      maker,
      base: pair.base.address,
      quote: pair.quote.address,
      expiry,
      version: 1n,
      link: ZERO32,
      parent: ZERO32,
      outputToVault: false,
      trailBps: 0n,
    };
    const trigger = (raw: string | undefined, what: string) => parseDecimal(raw, 18, vaultCodes.triggerInvalid, what);
    const rows: { kind: OrderKind; order: ChainOrder; amountBase: bigint; siblings: Hex[]; parentId: Hex | null }[] = [];
    const sell = (kind: OrderKind, above: boolean, priceWad: bigint, extra: Partial<ChainOrder> = {}) => ({
      kind,
      order: {
        ...base,
        isBuy: false,
        above,
        amountIn: amount,
        triggerWad: priceWad,
        minOut: this.sellMinOut(amount, priceWad, pair, slip),
        nonce: fresh(),
        ...extra,
      },
      amountBase: amount,
      siblings: [] as Hex[],
      parentId: null as Hex | null,
    });
    const buy = (kind: OrderKind, above: boolean, priceWad: bigint, extra: Partial<ChainOrder> = {}) => ({
      kind,
      order: {
        ...base,
        isBuy: true,
        above,
        amountIn: this.buySpend(amount, priceWad, pair),
        triggerWad: priceWad,
        minOut: (amount * (BPS - slip)) / BPS,
        nonce: fresh(),
        ...extra,
      },
      amountBase: amount,
      siblings: [] as Hex[],
      parentId: null as Hex | null,
    });

    if (input.kind !== 'trailing_stop' && input.trailPercent) refuse(vaultCodes.badRequest, 'Only a trailing stop takes a distance.');
    switch (input.kind) {
      case 'sell_above':
      case 'sell_below':
      case 'buy_above':
      case 'buy_below': {
        const p = trigger(input.trigger, 'The trigger price');
        const above = input.kind.endsWith('above');
        rows.push(input.kind.startsWith('sell') ? sell(input.kind, above, p) : buy(input.kind, above, p));
        break;
      }
      case 'take_profit_and_stop': {
        const tp = trigger(input.takeProfit, 'The take-profit price');
        const sl = trigger(input.stop, 'The stop price');
        const isSell = input.side === 'sell';
        if (isSell && tp <= sl) refuse(vaultCodes.tpNotAboveSl, 'On a sell, the take-profit must be above the stop.');
        if (!isSell && tp >= sl) refuse(vaultCodes.tpNotBelowSl, 'On a buy, the take-profit must be below the stop.');
        const link = keccak256(randomBytes(32)) as Hex;
        rows.push(isSell ? sell('take_profit', true, tp, { link }) : buy('take_profit', false, tp, { link }));
        rows.push(isSell ? sell('stop', false, sl, { link }) : buy('stop', true, sl, { link }));
        break;
      }
      case 'bracket': {
        if (input.side !== 'buy') refuse(vaultCodes.badRequest, 'A bracket here buys first, then sells with a take-profit and a stop.');
        const entry = trigger(input.trigger, 'The entry price');
        const tp = trigger(input.takeProfit, 'The take-profit price');
        const sl = trigger(input.stop, 'The stop price');
        if (tp <= sl) refuse(vaultCodes.tpNotAboveSl, 'On a sell, the take-profit must be above the stop.');
        const parent = buy('bracket', false, entry, { outputToVault: true });
        const parentId = this.orderId(maker, parent.order.nonce);
        const link = keccak256(randomBytes(32)) as Hex;
        rows.push(parent);
        const tpRow = sell('bracket_take_profit', true, tp, { link, parent: parentId });
        const slRow = sell('bracket_stop', false, sl, { link, parent: parentId });
        tpRow.parentId = parentId;
        slRow.parentId = parentId;
        rows.push(tpRow, slRow);
        break;
      }
      case 'trailing_stop': {
        if (input.trigger)
          refuse(vaultCodes.triggerNotAllowedOnTrailing, 'A trailing stop follows the price; it takes a distance, not a trigger price.');
        const bounds = this.settings.trailBounds;
        if (!bounds) refuse(vaultCodes.trailBoundsUnset, 'The trailing distance bounds are not published.');
        const pct = parseDecimal((input.trailPercent ?? '').replace(/%$/, ''), 2, vaultCodes.trailOutOfBounds, 'The distance');
        const bps = pct; // two decimals of a percent are basis points
        if (bps < BigInt(bounds!.min) || bps > BigInt(bounds!.max))
          refuse(vaultCodes.trailOutOfBounds, `The distance must be from ${bounds!.min / 100}% to ${bounds!.max / 100}%.`);
        const read = await this.chain.price(pair.base.address, pair.quote.address);
        if (read.status !== 'ok')
          return refuse(vaultCodes.priceUnavailable, 'A trailing stop needs a fresh price to start from. Try again.');
        const startTrigger = (read.priceWad * (BPS - bps)) / BPS;
        const isSell = input.side === 'sell';
        rows.push(
          isSell
            ? sell('trailing_stop', false, 0n, { trailBps: bps, minOut: this.sellMinOut(amount, startTrigger, pair, slip) })
            : buy('trailing_stop', true, 0n, { trailBps: bps, amountIn: this.buySpend(amount, (read.priceWad * (BPS + bps)) / BPS, pair) }),
        );
        break;
      }
      default:
        refuse(vaultCodes.badRequest, 'Unknown order type.');
    }

    // Credit: what the order spends must be in the vault now (a bracket's exits sell what the parent buys).
    const spends = rows.filter((r) => r.parentId === null);
    const spendToken = tokenIn(spends[0]!.order);
    const spendDecimals = spendToken === pair.base.address ? pair.base.decimals : pair.quote.decimals;
    const need = spends[0]!.order.amountIn;
    const credit = await this.chain.credit(maker, spendToken);
    if (credit < need)
      refuse(
        vaultCodes.insufficientCredit,
        `Deposit at least ${amountText(need, spendDecimals)} ${spendToken === pair.base.address ? pair.base.symbol : pair.quote.symbol} first.`,
      );
    await this.capCheck(principal, spendToken, need, spendDecimals);

    const ids = rows.map((r) => this.orderId(maker, r.order.nonce));
    for (const [i, r] of rows.entries()) {
      if (r.order.link !== ZERO32) r.siblings = ids.filter((id, j) => j !== i && rows[j]!.order.link === r.order.link);
    }
    const warnings = await this.warnings(rows.map((r) => r.order));
    const draft: Draft = {
      id: randomBytes(16).toString('hex'),
      wallet: principal.wallet,
      expiresAt: this.now().getTime() + DRAFT_TTL_MS,
      rows,
    };
    this.drafts.set(draft.id, draft);
    return {
      draftId: draft.id,
      orders: rows.map((r) => ({
        kind: r.kind,
        name: kindName[r.kind],
        typedData: this.typedData(r.order),
        minOut: amountText(r.order.minOut, r.order.isBuy ? pair.base.decimals : pair.quote.decimals),
        minOutSymbol: r.order.isBuy ? pair.base.symbol : pair.quote.symbol,
      })),
      warnings,
      sheet: { rate: RATE_COPY, resting: RESTING_COPY },
    };
  }

  /** A trigger the price has already passed fills at the next keeper pass: a warning with how far, never a refusal. */
  private async warnings(orders: readonly ChainOrder[]) {
    const pair = this.pair();
    const read = await this.chain.price(pair.base.address, pair.quote.address);
    if (read.status !== 'ok') return [];
    const out: { code: string; percentage: string }[] = [];
    for (const o of orders) {
      if (o.trailBps > 0n || o.triggerWad === 0n || o.parent !== ZERO32) continue;
      const passed = o.above ? read.priceWad >= o.triggerWad : read.priceWad <= o.triggerWad;
      if (passed) {
        const diff = read.priceWad > o.triggerWad ? read.priceWad - o.triggerWad : o.triggerWad - read.priceWad;
        out.push({ code: 'dex.order.would_fill_now', percentage: priceText((diff * 100n * WAD) / o.triggerWad) });
      }
    }
    return out;
  }

  private takeDraft(principal: OrderPrincipal, draftId: string, count: number): Draft {
    const draft = this.drafts.get(draftId);
    if (!draft || draft.expiresAt < this.now().getTime() || draft.wallet !== principal.wallet)
      return refuse(vaultCodes.draftExpired, 'This order was not prepared for this session, or it expired. Prepare it again.');
    if (count !== draft.rows.length) return refuse(vaultCodes.badRequest, `This order needs ${draft.rows.length} signatures.`);
    this.drafts.delete(draftId);
    return draft;
  }

  private async checkSignature(order: ChainOrder, signature: Hex): Promise<void> {
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        domain: this.domain(),
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: order,
        signature,
      });
    } catch {
      return refuse(vaultCodes.signatureInvalid, 'The signature does not recover.');
    }
    if (getAddress(signer) !== getAddress(order.maker)) refuse(vaultCodes.signatureInvalid, 'The order is not signed by this wallet.');
  }

  async create(principal: OrderPrincipal, draftId: string, signatures: readonly Hex[]) {
    const draft = this.takeDraft(principal, draftId, signatures.length);
    for (const [i, r] of draft.rows.entries()) await this.checkSignature(r.order, signatures[i]!);
    const at = this.now().toISOString();
    const rows: WalletOrder[] = draft.rows.map((r, i) => ({
      id: this.orderId(r.order.maker, r.order.nonce),
      kind: r.kind,
      order: r.order,
      amountBase: r.amountBase,
      signature: signatures[i]!,
      state: r.parentId ? 'waiting' : 'open',
      createdAt: at,
      updatedAt: at,
      filledIn: 0n,
      filledOut: 0n,
      round: 0,
      pending: null,
      cancelRequested: false,
      siblings: r.siblings,
      parentId: r.parentId,
      checkedVersion: 0,
      events: [{ at, type: 'created', version: 1, trigger: r.order.triggerWad > 0n ? priceText(r.order.triggerWad) : undefined }],
      attempts: [],
    }));
    this.store.insert(rows);
    return Promise.all(rows.map((row) => this.view(row)));
  }

  // ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────

  private owned(principal: OrderPrincipal, id: string): WalletOrder {
    const row = /^0x[0-9a-fA-F]{64}$/.test(id) ? this.store.get(id as Hex) : undefined;
    if (!row || row.order.maker.toLowerCase() !== principal.wallet)
      return refuse(vaultCodes.notFound, 'There is no such order for this wallet.');
    return row;
  }

  async view(row: WalletOrder) {
    const pair = this.pair();
    const sellsBase = !row.order.isBuy;
    const baseDecimals = pair.base.decimals;
    // The base amount the person asked for, and how much of it filled.
    const amountBase = row.amountBase;
    const filledBase = sellsBase ? row.filledIn : row.filledOut;
    let openBase = sellsBase ? row.order.amountIn - row.filledIn : amountBase > filledBase ? amountBase - filledBase : 0n;
    let trigger: bigint = row.order.triggerWad;
    let mark: bigint | null = null;
    let cover: bigint | null = null;
    try {
      if (this.chain.wired) {
        const price = await this.chain.price(pair.base.address, pair.quote.address);
        if (price.status === 'ok') mark = price.priceWad;
        if (row.order.trailBps > 0n) {
          const wm = await this.chain.watermark(row.order);
          if (wm > 0n) trigger = row.order.above ? (wm * (BPS + row.order.trailBps)) / BPS : (wm * (BPS - row.order.trailBps)) / BPS;
        }
        if (sellsBase && !FINAL_STATES.has(row.state)) openBase = await this.chain.remaining(row.order);
        if (row.kind === 'bracket') cover = await this.chain.boughtOut(row.id);
      }
    } catch {
      // a chain read that fails leaves the stored figures
    }
    const st = (s: WalletOrderState) =>
      ({
        open: 'Open',
        waiting: 'Waiting for parent',
        executing: 'Executing',
        filled: 'Filled',
        cancelled: 'Cancelled',
        cancelled_by_link: 'Cancelled by link',
        expired: 'Expired',
      })[s];
    return {
      id: row.id,
      kind: row.kind,
      kindName: kindName[row.kind],
      side: row.order.isBuy ? ('buy' as const) : ('sell' as const),
      state: row.state,
      stateName: st(row.state),
      amount: amountText(amountBase, baseDecimals),
      filled: amountText(filledBase, baseDecimals),
      open: amountText(FINAL_STATES.has(row.state) ? 0n : openBase, baseDecimals),
      baseSymbol: pair.base.symbol,
      quoteSymbol: pair.quote.symbol,
      trigger: trigger > 0n ? priceText(trigger) : null,
      trailPercent: row.order.trailBps > 0n ? amountText(row.order.trailBps, 2) : null,
      mark: mark !== null ? priceText(mark) : null,
      minOut: amountText(row.order.minOut, row.order.isBuy ? pair.base.decimals : pair.quote.decimals),
      minOutSymbol: row.order.isBuy ? pair.base.symbol : pair.quote.symbol,
      cover: cover !== null ? amountText(cover, baseDecimals) : null,
      version: Number(row.order.version),
      expiresAt: new Date(Number(row.order.expiry) * 1000).toISOString(),
      createdAt: row.createdAt,
      editable: !FINAL_STATES.has(row.state) && row.order.trailBps === 0n && row.state !== 'executing',
      cancellable: !FINAL_STATES.has(row.state),
      siblings: [...row.siblings],
      parentId: row.parentId,
      sheet: { rate: RATE_COPY, resting: RESTING_COPY },
    };
  }

  async list(principal: OrderPrincipal, input: { state?: WalletOrderState; cursor?: string; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
    const start = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0) return refuse(vaultCodes.badRequest, 'The cursor is not one this list gave.');
    const rows = this.store.byMaker(principal.wallet).filter((row) => !input.state || row.state === input.state);
    const page = rows.slice(start, start + limit);
    return {
      orders: await Promise.all(page.map((row) => this.view(row))),
      total: rows.length,
      pageSize: PAGE_SIZE,
      next: start + limit < rows.length ? String(start + limit) : null,
    };
  }

  history(principal: OrderPrincipal, id: string) {
    const row = this.owned(principal, id);
    return { id: row.id, events: [...row.events], attempts: [...row.attempts] };
  }

  countByMaker(wallet: string): number {
    return this.store.byMaker(wallet).length;
  }

  // ── Changing ──────────────────────────────────────────────────────────────────────────────────────────────────

  async prepareEdit(principal: OrderPrincipal, id: string, input: { trigger: string }) {
    const row = this.owned(principal, id);
    if (FINAL_STATES.has(row.state) || row.state === 'executing')
      return refuse(
        vaultCodes.notEditable,
        row.state === 'filled' ? 'A filled order cannot be edited.' : 'This order cannot be edited now.',
      );
    if (row.order.trailBps > 0n)
      return refuse(vaultCodes.triggerNotAllowedOnTrailing, 'A trailing stop follows the price; its trigger cannot be set.');
    const pair = this.pair();
    const slip = this.slippage();
    const p = parseDecimal(input.trigger, 18, vaultCodes.triggerInvalid, 'The trigger price');
    const amountBase = row.amountBase;
    const next: ChainOrder = {
      ...row.order,
      triggerWad: p,
      version: row.order.version + 1n,
      ...(row.order.isBuy ? { amountIn: this.buySpend(amountBase, p, pair) } : { minOut: this.sellMinOut(amountBase, p, pair, slip) }),
    };
    // Once any fill showed the old signature on chain, only an on-chain version raise kills it.
    const replace = row.filledIn > 0n;
    const draft: Draft = {
      id: randomBytes(16).toString('hex'),
      wallet: principal.wallet,
      expiresAt: this.now().getTime() + DRAFT_TTL_MS,
      rows: [{ kind: row.kind, order: next, amountBase: row.amountBase, siblings: [...row.siblings], parentId: row.parentId }],
      editOf: row.id,
    };
    this.drafts.set(draft.id, draft);
    return {
      draftId: draft.id,
      typedData: this.typedData(next),
      version: Number(next.version),
      replaceOnChain: replace,
      sheet: replace
        ? 'This order has filled before, so its old signature is on chain: the edit also sends a replace from your wallet.'
        : 'This edit is a new signature only: the old one was never on chain and stops at once.',
      call: replace
        ? ({
            label: `Replace order version ${row.order.version} with ${next.version}`,
            to: this.chain.vault!,
            data: encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'raiseVersion', args: [row.order.nonce, next.version] }),
          } satisfies UnsignedCall)
        : null,
    };
  }

  async update(principal: OrderPrincipal, draftId: string, signature: Hex) {
    const draft = this.takeDraft(principal, draftId, 1);
    if (!draft.editOf) return refuse(vaultCodes.badRequest, 'This is not an edit.');
    const row = this.owned(principal, draft.editOf);
    if (FINAL_STATES.has(row.state) || row.state === 'executing') return refuse(vaultCodes.notEditable, 'This order cannot be edited now.');
    const next = draft.rows[0]!.order;
    await this.checkSignature(next, signature);
    row.order = next;
    row.signature = signature;
    row.updatedAt = this.now().toISOString();
    row.events.push({ at: row.updatedAt, type: 'edit', version: Number(next.version), trigger: priceText(next.triggerWad) });
    this.store.save();
    return this.view(row);
  }

  /** Records the cancel at once (the keeper stops filling) and returns the unsigned cancel the wallet signs. */
  async cancel(principal: OrderPrincipal, id: string) {
    const row = this.owned(principal, id);
    if (FINAL_STATES.has(row.state)) return refuse(vaultCodes.notCancellable, 'This order has already finished.');
    const at = this.now().toISOString();
    const targets = [row, ...this.store.byMaker(principal.wallet).filter((r) => r.parentId === row.id && !FINAL_STATES.has(r.state))];
    for (const t of targets) {
      t.cancelRequested = true;
      // An executing fill keeps its row until the chain answers; every other state ends now.
      if (t.state !== 'executing') t.state = 'cancelled';
      t.updatedAt = at;
      t.events.push({ at, type: 'cancel' });
    }
    this.store.save();
    return {
      order: await this.view(row),
      copy: CANCEL_COPY,
      calls: targets.map(
        (t) =>
          ({
            label: `Cancel ${kindName[t.kind]} on chain`,
            to: this.chain.vault ?? getAddress(principal.wallet),
            data: encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'cancel', args: [t.order.nonce] }),
          }) satisfies UnsignedCall,
      ),
    };
  }
}

export const tokenIn = (o: ChainOrder): Address => (o.isBuy ? o.quote : o.base);
export const tokenOut = (o: ChainOrder): Address => (o.isBuy ? o.base : o.quote);
export const hashOrderFor = (domain: { name: string; version: string; chainId: number; verifyingContract: Address }, order: ChainOrder) =>
  hashTypedData({ domain, types: ORDER_TYPES, primaryType: 'Order', message: order });
