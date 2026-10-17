import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { lifecycleAdmissionProofSchema } from '../lifecycle-proof.js';
import type { Market, OrderRecord, OrderSide, OrderStatus, OrderType, RecoveryReason, TimeInForce } from './types.js';

/**
 * THE PARSE BOUNDARY.
 *
 * Postgres hands `numeric(38,18)` back as a decimal string and `numeric(8,0)`
 * as a decimal string too. This file is the only place either becomes a
 * TypeScript value, so there is exactly one line to inspect when asking "could
 * a float have got in here" — and the answer is no, because `parseAmount`
 * rejects anything lossy and `Number` is applied only to basis points, which
 * are counts rather than quantities of value.
 */

export interface MarketRow {
  id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  kind: Market['kind'];
  tick_size: string;
  lot_size: string;
  min_qty: string;
  max_qty: string | null;
  min_notional: string;
  status: Market['status'];
  maker_bps: string;
  taker_bps: string;
  listed_at: Date | null;
  asset_class: Market['assetClass'];
  schedule: Market['schedule'];
  paper: boolean;
  display_name?: string;
  test?: boolean;
  test_fixture?: unknown;
  futures_contract_style?: 'perpetual' | 'dated' | null;
  futures_expiry_at?: Date | null;
  futures_settlement_fixing?: string | null;
}

function testFixtureOf(raw: unknown): Market['testFixture'] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const cap = (value as { leverageCap?: unknown }).leverageCap;
  const feed = (value as { markFeed?: unknown }).markFeed;
  const policy = (value as { liquidationPolicy?: unknown }).liquidationPolicy;
  if (typeof cap !== 'string' || typeof feed !== 'string') return null;
  if (typeof policy !== 'string' && (policy == null || typeof policy !== 'object' || Array.isArray(policy))) return null;
  let leverageCap: string;
  try {
    leverageCap = formatAmount(parseAmount(cap));
  } catch {
    return null;
  }
  return {
    leverageCap,
    markFeed: feed,
    liquidationPolicy: policy as string | Record<string, unknown>,
  };
}

export function toMarket(row: MarketRow): Market {
  const style = row.kind === 'futures' ? (row.futures_contract_style === 'dated' ? 'dated' : 'perpetual') : null;
  const displayName = row.display_name && row.display_name.length > 0 ? row.display_name : undefined;
  return {
    id: row.id,
    symbol: row.symbol,
    baseAsset: row.base_asset,
    quoteAsset: row.quote_asset,
    kind: row.kind,
    tickSize: parseAmount(row.tick_size),
    lotSize: parseAmount(row.lot_size),
    minQty: parseAmount(row.min_qty),
    maxQty: row.max_qty === null ? null : parseAmount(row.max_qty),
    minNotional: parseAmount(row.min_notional),
    status: row.status,
    makerBps: Number(row.maker_bps),
    takerBps: Number(row.taker_bps),
    listedAt: row.listed_at,
    assetClass: row.asset_class,
    schedule: row.schedule,
    paper: row.paper === true,
    ...(displayName ? { displayName } : {}),
    test: row.test === true,
    testFixture: row.test === true ? testFixtureOf(row.test_fixture) : null,
    futuresContractStyle: style,
    futuresExpiryAt: row.futures_expiry_at ?? null,
    futuresSettlementFixing: row.futures_settlement_fixing ?? null,
  };
}

export interface OrderRow {
  id: string;
  user_id: string;
  sub_account_id: string | null;
  market_id: string;
  client_order_id: string | null;
  side: OrderSide;
  type: OrderType;
  price: string | null;
  qty: string;
  filled_qty: string;
  status: OrderStatus;
  tif: TimeInForce;
  hold_asset: string;
  hold_amount: string;
  amend_released: string;
  fee_discount_bps: string;
  protection_price: string | null;
  engine_sequence: number | null;
  engine_version: number;
  seeded: boolean;
  reject_code: string | null;
  recovery_reason: RecoveryReason | null;
  reconciliation_key: string | null;
  lifecycle_proof: unknown | null;
  replacement_of: string | null;
  replacement_request_hash: string | null;
  session_id: string | null;
  api_key_id: string | null;
  created_at: Date;
}

function readLifecycleProof(value: unknown): OrderRecord['lifecycleProof'] {
  if (value == null) return null;
  // postgres.js can hand a jsonb string back as text. One parse, then the schema.
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return lifecycleAdmissionProofSchema.parse(parsed);
}

export function toOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    userId: row.user_id,
    subAccountId: row.sub_account_id,
    marketId: row.market_id,
    clientOrderId: row.client_order_id,
    side: row.side,
    type: row.type,
    price: row.price === null ? null : parseAmount(row.price),
    qty: parseAmount(row.qty),
    filledQty: parseAmount(row.filled_qty),
    status: row.status,
    tif: row.tif,
    holdAsset: row.hold_asset,
    holdAmount: parseAmount(row.hold_amount),
    amendReleased: parseAmount(row.amend_released ?? '0'),
    feeDiscountBps: Number(row.fee_discount_bps),
    protectionPrice: row.protection_price === null ? null : parseAmount(row.protection_price),
    engineSequence: row.engine_sequence,
    engineVersion: row.engine_version ?? 1,
    seeded: Boolean(row.seeded),
    rejectCode: row.reject_code,
    recoveryReason: row.recovery_reason,
    reconciliationKey: row.reconciliation_key,
    lifecycleProof: readLifecycleProof(row.lifecycle_proof),
    replacementOf: row.replacement_of,
    replacementRequestHash: row.replacement_request_hash,
    sessionId: row.session_id ?? null,
    apiKeyId: row.api_key_id ?? null,
    createdAt: row.created_at,
  };
}

export interface FillRow {
  id: string;
  order_id: string;
  counter_order_id: string;
  market_id: string;
  user_id: string;
  side: OrderSide;
  liquidity: 'maker' | 'taker';
  price: string;
  qty: string;
  quote_amount: string;
  fee_asset: string;
  fee_amount: string;
  fee_bps: string;
  sequence: number;
  ts: Date;
  session_id: string | null;
  api_key_id: string | null;
}

export function toFill(row: FillRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    counterOrderId: row.counter_order_id,
    marketId: row.market_id,
    userId: row.user_id,
    side: row.side,
    liquidity: row.liquidity,
    price: parseAmount(row.price),
    qty: parseAmount(row.qty),
    quoteAmount: parseAmount(row.quote_amount),
    feeAsset: row.fee_asset,
    feeAmount: parseAmount(row.fee_amount),
    feeBps: Number(row.fee_bps),
    sequence: row.sequence,
    ts: row.ts,
    sessionId: row.session_id ?? null,
    apiKeyId: row.api_key_id ?? null,
  };
}
