/**
 * Maker-routed OTC settle — SOCKET §13 `socket.otc-maker-routing`.
 *
 * Platform-principal settle is real (marketMakerMakerFill). Routing a bound
 * fill to an external maker needs an owner-published routing recipe + ledger
 * path. Until then, settle must refuse by name — never invent a maker book.
 */

import { logRefusalSpec } from '../refusal-spec-log.js';
import { OtcError } from './errors.js';

export const OTC_MAKER_ROUTING_SOCKET = 'socket.otc-maker-routing' as const;

export const OTC_MAKER_ROUTING_RESIDUAL =
  'Sending this OTC trade to an outside maker is not available yet. Only the platform can be the counterparty.';

export type OtcMakerRoutingCounterparty = 'platform' | 'maker';

/**
 * Owner-published routing recipe for the OTC socket.
 *
 * This is deliberately only a counterparty declaration. It does not name a
 * maker book, account, or settlement path; those remain refuse-closed until
 * the external-maker ledger recipe exists.
 */
export type OtcMakerRoutingRecipe = {
  readonly published: true;
  readonly counterparty: OtcMakerRoutingCounterparty;
};

function refuseRouting(message: string): never {
  logRefusalSpec('trade.otc_settle_refused');
  throw new OtcError(message, 'trade.otc_settle_refused', OTC_MAKER_ROUTING_RESIDUAL);
}

/**
 * Parse TRADE_OTC_MAKER_ROUTING.
 *
 * Unlike the desk law, blank routing is not a usable default: an operator
 * must explicitly publish which principal the route selects. Invalid or
 * ambiguous JSON fails closed rather than allowing a hidden second
 * counterparty to enter the settle path.
 */
export function parseOtcMakerRoutingJson(raw: string | null | undefined): OtcMakerRoutingRecipe {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    refuseRouting(`TRADE_OTC_MAKER_ROUTING is blank — ${OTC_MAKER_ROUTING_SOCKET} refuses`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    refuseRouting(`TRADE_OTC_MAKER_ROUTING is not valid JSON — ${OTC_MAKER_ROUTING_SOCKET} refuses`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuseRouting(`TRADE_OTC_MAKER_ROUTING must be an object — ${OTC_MAKER_ROUTING_SOCKET} refuses`);
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published !== true) {
    refuseRouting(`TRADE_OTC_MAKER_ROUTING.published must be true — ${OTC_MAKER_ROUTING_SOCKET} refuses`);
  }
  if (obj.counterparty !== 'platform' && obj.counterparty !== 'maker') {
    refuseRouting(`TRADE_OTC_MAKER_ROUTING.counterparty must be platform|maker — ${OTC_MAKER_ROUTING_SOCKET} refuses`);
  }
  const keys = Object.keys(obj);
  if (keys.some((key) => key !== 'published' && key !== 'counterparty')) {
    refuseRouting(`TRADE_OTC_MAKER_ROUTING contains unsupported fields — ${OTC_MAKER_ROUTING_SOCKET} refuses ambiguous routing`);
  }

  return { published: true, counterparty: obj.counterparty };
}

export function otcMakerRoutingStatus() {
  logRefusalSpec('trade.otc_settle_refused');
  return {
    published: false as const,
    socket: OTC_MAKER_ROUTING_SOCKET,
    residual: OTC_MAKER_ROUTING_RESIDUAL,
  };
}
