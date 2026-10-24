import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { amountSchema, signedAmountSchema, EVENT_CATALOG } from './catalog.js';
import { EventValidationError, validatePayload } from './bus.js';
import type { PayloadOf } from './catalog.js';

/**
 * D26-P4-05 — freeze `positionUpdated` so later WS wiring cannot invent a
 * second private-positions shape.
 *
 * Required keys must stay present. Money fields stay decimal strings (never
 * JSON numbers). Optional is only `closingReason`. Breaking a field in
 * `catalog.ts` without updating this list fails the suite.
 */

/** Keys the wire must always carry (null is allowed where the catalog says so). */
export const POSITION_UPDATED_REQUIRED_KEYS = [
  'positionId',
  'userId',
  'marketId',
  'symbol',
  'status',
  'side',
  'contracts',
  'entryPrice',
  'markPrice',
  'notional',
  'leverage',
  'collateral',
  'unrealizedPnl',
  'realizedPnl',
  'liquidationPrice',
  'marginMode',
  'fundingPaid',
  'ts',
] as const;

/** The only key a publisher may omit. */
export const POSITION_UPDATED_OPTIONAL_KEYS = ['closingReason'] as const;

/**
 * Decimal-string money / size / price fields. `null` is legal where the
 * catalog wraps the field in `.nullable()`; a JSON number is never legal.
 * Pnl and funding use `signedAmountSchema`. The rest stay on `amountSchema`.
 */
export const POSITION_UPDATED_MONEY_FIELDS = [
  'contracts',
  'entryPrice',
  'markPrice',
  'notional',
  'leverage',
  'collateral',
  'unrealizedPnl',
  'realizedPnl',
  'liquidationPrice',
  'fundingPaid',
] as const;

type RequiredKey = (typeof POSITION_UPDATED_REQUIRED_KEYS)[number];
type MoneyField = (typeof POSITION_UPDATED_MONEY_FIELDS)[number];

function payloadShape(): z.ZodObject<Record<string, z.ZodType>> {
  const schema = EVENT_CATALOG.positionUpdated.schema;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('positionUpdated payload must remain a ZodObject');
  }
  return schema;
}

function legalPayload(): PayloadOf<'positionUpdated'> {
  return {
    positionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    marketId: 'btc-usdt-perp',
    symbol: 'BTC/USDT:USDT',
    status: 'open',
    side: 'long',
    contracts: '1.250000000000000000',
    entryPrice: '64000.5',
    markPrice: '64110',
    notional: '80137.5',
    leverage: '5',
    collateral: '16027.5',
    unrealizedPnl: '137.5',
    realizedPnl: '0',
    liquidationPrice: '52000',
    marginMode: 'cross',
    fundingPaid: '-0.004000000000000000',
    ts: new Date().toISOString(),
  };
}

describe('D26-P4-05 positionUpdated payload freeze', () => {
  it('pins subject and version so WS agents have a stable name', () => {
    expect(EVENT_CATALOG.positionUpdated.subject).toBe('intafaced.trade.position.updated');
    expect(EVENT_CATALOG.positionUpdated.version).toBe(1);
  });

  it('documents required keys — catalog shape must match the freeze list', () => {
    const keys = Object.keys(payloadShape().shape).sort();
    const frozen = [...POSITION_UPDATED_REQUIRED_KEYS, ...POSITION_UPDATED_OPTIONAL_KEYS].sort();
    expect(keys).toEqual(frozen);

    for (const key of POSITION_UPDATED_REQUIRED_KEYS) {
      expect(payloadShape().shape[key]?.isOptional()).toBe(false);
    }
    for (const key of POSITION_UPDATED_OPTIONAL_KEYS) {
      expect(payloadShape().shape[key]?.isOptional()).toBe(true);
    }
  });

  it('keeps unsigned money on amountSchema and signed pnl and funding on signedAmountSchema', () => {
    const signed = new Set<string>(['unrealizedPnl', 'realizedPnl', 'fundingPaid']);
    for (const field of POSITION_UPDATED_MONEY_FIELDS) {
      let inner: z.ZodTypeAny = payloadShape().shape[field]!;
      while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
        inner = inner.unwrap() as z.ZodTypeAny;
      }
      expect(inner).toBe(signed.has(field) ? signedAmountSchema : amountSchema);
    }
  });

  it('accepts a legal payload whose money fields stay strings after JSON round-trip', () => {
    const payload = legalPayload();
    const accepted = validatePayload('positionUpdated', payload);
    const roundTripped = JSON.parse(JSON.stringify(accepted)) as PayloadOf<'positionUpdated'>;
    expect(() => validatePayload('positionUpdated', roundTripped)).not.toThrow();
    for (const field of POSITION_UPDATED_MONEY_FIELDS) {
      expect(typeof roundTripped[field]).toBe('string');
    }
  });

  it.each(POSITION_UPDATED_REQUIRED_KEYS)('rejects a payload missing required key %s', (key: RequiredKey) => {
    const broken: Record<string, unknown> = { ...legalPayload() };
    delete broken[key];
    expect(() => validatePayload('positionUpdated', broken)).toThrow(EventValidationError);
  });

  it.each(POSITION_UPDATED_MONEY_FIELDS)('rejects JSON number on money field %s', (field: MoneyField) => {
    const poisoned = JSON.parse(JSON.stringify({ ...legalPayload(), [field]: 1.25 })) as Record<string, unknown>;
    expect(typeof poisoned[field]).toBe('number');
    expect(() => validatePayload('positionUpdated', poisoned)).toThrow(EventValidationError);
  });

  it('still accepts null on nullable money fields', () => {
    const payload = {
      ...legalPayload(),
      markPrice: null,
      leverage: null,
      collateral: null,
      unrealizedPnl: null,
      realizedPnl: null,
      liquidationPrice: null,
    };
    expect(() => validatePayload('positionUpdated', payload)).not.toThrow();
  });
});
