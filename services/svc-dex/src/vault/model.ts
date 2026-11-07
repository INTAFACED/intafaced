import type { Address, Hex } from 'viem';

/** The order exactly as the maker signs it and the vault checks it (OrderVault.Order). */
export interface ChainOrder {
  readonly maker: Address;
  readonly base: Address;
  readonly quote: Address;
  readonly isBuy: boolean;
  readonly above: boolean;
  readonly amountIn: bigint;
  readonly triggerWad: bigint;
  readonly trailBps: bigint;
  readonly minOut: bigint;
  /** Unix seconds. */
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly version: bigint;
  readonly link: Hex;
  readonly parent: Hex;
  readonly outputToVault: boolean;
}

export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

export const ORDER_KINDS = [
  'sell_above',
  'sell_below',
  'buy_above',
  'buy_below',
  'take_profit',
  'stop',
  'bracket',
  'bracket_take_profit',
  'bracket_stop',
  'trailing_stop',
] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/**
 * The states a person sees (VLT-7 mapped): `waiting` is a bracket exit whose parent has not bought yet; `cancelled_by_link`
 * is the other leg of a one-cancels-other pair once one leg filled in full.
 */
export const ORDER_STATES = ['open', 'waiting', 'executing', 'filled', 'cancelled', 'cancelled_by_link', 'expired'] as const;
export type WalletOrderState = (typeof ORDER_STATES)[number];

export const FINAL_STATES: ReadonlySet<WalletOrderState> = new Set(['filled', 'cancelled', 'cancelled_by_link', 'expired']);

/** One token of the pair the vault trades, as the owner published it. */
export interface PairToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface OrderPair {
  readonly base: PairToken;
  readonly quote: PairToken;
  /** The pool the keeper fills through. */
  readonly pool: Address;
}

export type OrderEventType = 'created' | 'fill' | 'edit' | 'cancel' | 'cancel_refused_fill' | 'expired' | 'cancelled_by_link' | 'activated';

export interface OrderEvent {
  readonly at: string;
  readonly type: OrderEventType;
  /** A fill: what went in and came out, and the minimum this fill had to pay. Decimal strings in the tokens' units. */
  readonly amountIn?: string;
  readonly amountOut?: string;
  readonly minOut?: string;
  readonly price?: string;
  readonly label?: 'partial' | 'full' | 'take-profit' | 'stop' | 'trailing';
  readonly txHash?: string;
  readonly version?: number;
  readonly trigger?: string;
}

export interface KeeperAttempt {
  readonly at: string;
  /** predicate_false, oracle_stale, oracle_disagree, insufficient_liquidity, insufficient_credit, reverted, rail.crypto, checked */
  readonly reason: string;
  readonly version: number;
  /** The trigger the keeper checked against, and the price it read, decimal strings. */
  readonly trigger?: string;
  readonly price?: string;
}

export interface PendingFill {
  readonly key: string;
  readonly round: number;
  readonly take: bigint;
  readonly txHash: Hex | null;
  /** True once the send was started: a send that threw may still have been broadcast, so it is looked for on chain. */
  readonly sendStarted?: boolean;
  /** Passes that looked for an unknown send on chain and found nothing. */
  readonly looked?: number;
}

export interface WalletOrder {
  readonly id: Hex;
  readonly kind: OrderKind;
  order: ChainOrder;
  /** The base amount the person asked for, smallest units (a buy spends quote for it). */
  readonly amountBase: bigint;
  signature: Hex;
  state: WalletOrderState;
  readonly createdAt: string;
  updatedAt: string;
  /** Input spent and output received across fills, smallest units. */
  filledIn: bigint;
  filledOut: bigint;
  round: number;
  pending: PendingFill | null;
  /** Set the moment the maker cancels: the keeper reads it before every send. */
  cancelRequested: boolean;
  /** The ids of the orders that share this order's link (one-cancels-other) and of a bracket's parent. */
  readonly siblings: readonly Hex[];
  readonly parentId: Hex | null;
  /** The last version the keeper logged a check for. */
  checkedVersion: number;
  events: OrderEvent[];
  attempts: KeeperAttempt[];
}
