import {
  QUANT_CLIENT_STRATEGY_ID_UNSET,
  QUANT_IDEMPOTENCY_CONFLICT,
  QUANT_IDEMPOTENCY_KEY_UNSET,
  QUANT_LIST_CURSOR_INVALID,
  QuantError,
} from '../errors.js';

const KEY_MAX = 128;

/** Blank is refused. A missing client id is not generated. */
export function requireClientStrategyId(raw: string | null | undefined): string {
  const id = raw?.trim() ?? '';
  if (!id) {
    throw new QuantError(QUANT_CLIENT_STRATEGY_ID_UNSET, 'clientStrategyId is unset');
  }
  if (id.length > KEY_MAX) {
    throw new QuantError('quant.params_invalid', 'clientStrategyId is longer than 128 characters');
  }
  return id;
}

/** Blank is refused. A missing write key is not generated. */
export function requireIdempotencyKey(raw: string | null | undefined): string {
  const key = raw?.trim() ?? '';
  if (!key) {
    throw new QuantError(QUANT_IDEMPOTENCY_KEY_UNSET, 'idempotencyKey is unset');
  }
  if (key.length > KEY_MAX) {
    throw new QuantError('quant.params_invalid', 'idempotencyKey is longer than 128 characters');
  }
  return key;
}

export function encodeListCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

/** A cursor that is not from this list is refused. It is not treated as the first page. */
export function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  let text = '';
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    text = '';
  }
  const sep = text.indexOf('|');
  const createdAt = sep > 0 ? text.slice(0, sep) : '';
  const id = sep > 0 ? text.slice(sep + 1) : '';
  if (!id || Number.isNaN(Date.parse(createdAt))) {
    throw new QuantError(QUANT_LIST_CURSOR_INVALID, 'cursor is not a list cursor');
  }
  return { createdAt, id };
}

export function idempotencyConflict(operation: string): never {
  throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, `idempotencyKey was already used for ${operation}`);
}
