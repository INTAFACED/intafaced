import type { Draft } from '../../../features/trade/trade-api';
import type { DeskMarket } from './market';
import { hasExits, serviceType, type Checked, type OrderType, type Side } from './order-math';
import { tifFields, type Tif } from './tif';

/**
 * The order the service is asked about and to place, from a form the client rules accept. An OCO is a limit sell
 * priced at its take-profit; a bracket is a market (or immediate limit) buy. Both carry their exit prices in `exit`.
 */
export function draftOf(args: {
  market: Pick<DeskMarket, 'symbol'>;
  side: Side;
  type: OrderType;
  tif: Tif;
  checked: Extract<Checked, { ok: true }>;
  clientOrderId: string;
}): Draft {
  const { market, side, type, tif, checked, clientOrderId } = args;
  const sent = serviceType(type, checked.price ?? '');
  // A bracket's market entry is already immediate; only fill-or-kill changes how it is sent.
  const sentTif: Tif = type === 'bracket' && sent === 'market' ? (tif === 'FOK' ? 'FOK' : 'GTC') : tif;
  return {
    symbol: market.symbol,
    side,
    type: sent,
    amount: checked.amount,
    ...(checked.price ? { price: checked.price } : {}),
    ...(checked.stopPrice ? { stopPrice: checked.stopPrice } : {}),
    ...tifFields(sentTif),
    ...(checked.exit && hasExits(type) ? { exit: { kind: type as 'oco' | 'bracket', ...checked.exit } } : {}),
    clientOrderId,
  };
}
