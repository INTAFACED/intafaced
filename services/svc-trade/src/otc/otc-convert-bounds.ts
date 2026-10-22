/**
 * One-click large buy and convert at OTC pricing: owner amount bounds (CB-otc-12).
 *
 * TRADE_OTC_CONVERT_BOUNDS publishes separate bounds for the two flows, as
 * base-asset quantities: `{"convert":{"minQty":"…","maxQty":"…"},"oneClickBuy":{…}}`.
 * A flow with no published bounds refuses `trade.convert_bounds_not_set`;
 * blank never means unbounded. Amounts are decimal strings, held as scaled bigint.
 */

import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { OtcError } from './errors.js';

export type OtcConvertFlow = 'convert' | 'oneClickBuy';

export interface OtcConvertFlowBounds {
  readonly minQty: Amount;
  readonly maxQty: Amount;
}

export type OtcConvertBounds = Readonly<Partial<Record<OtcConvertFlow, OtcConvertFlowBounds>>>;

export const NO_OTC_CONVERT_BOUNDS: OtcConvertBounds = {};

const FLOWS: readonly OtcConvertFlow[] = ['convert', 'oneClickBuy'];
const DECIMAL = /^\d+(\.\d{1,18})?$/;

function refuse(message: string): never {
  throw new OtcError(message, 'trade.convert_bounds_not_set');
}

function parseQty(value: unknown, label: string): Amount {
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) refuse(`${label} must be a decimal string`);
  const qty = parseAmount((value as string).trim());
  if (qty <= 0n) refuse(`${label} must be greater than zero`);
  return qty;
}

/** Blank → no flow has bounds (every OTC convert refuses). Malformed → refuses. */
export function parseOtcConvertBoundsJson(raw: string | null | undefined): OtcConvertBounds {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return NO_OTC_CONVERT_BOUNDS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    refuse('TRADE_OTC_CONVERT_BOUNDS is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) refuse('TRADE_OTC_CONVERT_BOUNDS must be an object');
  const obj = parsed as Record<string, unknown>;
  const out: Partial<Record<OtcConvertFlow, OtcConvertFlowBounds>> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!FLOWS.includes(key as OtcConvertFlow)) refuse(`TRADE_OTC_CONVERT_BOUNDS has unknown flow ${key}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`TRADE_OTC_CONVERT_BOUNDS.${key} must be an object`);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((k) => k !== 'minQty' && k !== 'maxQty')) refuse(`TRADE_OTC_CONVERT_BOUNDS.${key} has unsupported fields`);
    const minQty = parseQty(row.minQty, `TRADE_OTC_CONVERT_BOUNDS.${key}.minQty`);
    const maxQty = parseQty(row.maxQty, `TRADE_OTC_CONVERT_BOUNDS.${key}.maxQty`);
    if (minQty > maxQty) refuse(`TRADE_OTC_CONVERT_BOUNDS.${key}.minQty is above maxQty`);
    out[key as OtcConvertFlow] = { minQty, maxQty };
  }
  return out;
}

/** Refuse unless `qty` is inside the owner bounds of `flow`. */
export function assertOtcConvertBounds(bounds: OtcConvertBounds, flow: OtcConvertFlow, qty: Amount): void {
  const b = bounds[flow];
  if (!b)
    throw new OtcError(
      `No amount bounds are set for ${flow} — refuse rather than treat blank as unbounded`,
      'trade.convert_bounds_not_set',
    );
  if (qty < b.minQty || qty > b.maxQty) {
    throw new OtcError(
      `Amount ${formatAmount(qty)} is outside the ${flow} bounds ${formatAmount(b.minQty)}–${formatAmount(b.maxQty)}`,
      'trade.convert_out_of_bounds',
    );
  }
}

/** Read for the screen: each flow's bounds, or null when not set. */
export function describeOtcConvertBounds(bounds: OtcConvertBounds) {
  const view = (flow: OtcConvertFlow) => {
    const b = bounds[flow];
    return b ? { minQty: formatAmount(b.minQty), maxQty: formatAmount(b.maxQty) } : null;
  };
  return { convert: view('convert'), oneClickBuy: view('oneClickBuy') };
}
