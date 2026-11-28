import type { AnySpotRefusedOrderType, SpotOrderTypes } from '@intafaced/contracts/spot-order-types';
import { deskCopy } from '../../../screens/trade/desk/copy';
import { REFUSED_NAME_KEY, TYPE_TAB_KEY } from '../../../screens/trade/desk/tif';
import { venueCopy } from '../../trade';
import { tradingApiCopy } from './trading-api-copy';

type Accepted = SpotOrderTypes['accepted'][number];
type Refused = SpotOrderTypes['refused'][number];
type TradingT = ReturnType<typeof tradingApiCopy.useCopy>['t'];
type DeskT = ReturnType<typeof deskCopy.useCopy>['t'];
type VenueT = ReturnType<typeof venueCopy.useCopy>['t'];

const VENUE_REFUSED_KEY: Record<AnySpotRefusedOrderType, 'type_stop_limit' | 'type_stop' | 'type_take_profit' | 'type_trailing_stop'> = {
  stop_limit: 'type_stop_limit',
  stop: 'type_stop',
  take_profit: 'type_take_profit',
  trailing_stop: 'type_trailing_stop',
};

/**
 * The cells of one accepted type, shared by /developers/order-types and its markdown variant so the two never drift:
 * the ticket's own name for the type, the body types, the fields that make it this kind, its times in force and its
 * note. Body types are joined with "or", never a pipe, so a markdown table keeps its columns.
 */
export function acceptedCells(row: Accepted, t: TradingT, desk: DeskT, source: SpotOrderTypes['source'] = 'book') {
  const note =
    row.id === 'market' ? (source === 'venue' ? t('note_venue_market') : t('note_market')) : row.id === 'bracket' ? t('note_bracket') : '';
  return {
    name: desk(TYPE_TAB_KEY[row.id]),
    bodyType: row.send.type.join(' or '),
    fields: row.send.fields.length ? row.send.fields.join(', ') : null,
    timeInForce: row.timeInForce.join(', '),
    note,
    example: JSON.stringify(row.send.example, null, 2),
  };
}

/** A refused kind, named exactly as the ticket names it (the venue's copy when the venue door is on). */
export function refusedName(row: Refused, desk: DeskT, source: SpotOrderTypes['source'] = 'book', venue?: VenueT): string {
  if (source !== 'venue' && row.id === 'trailing_stop') {
    return desk(REFUSED_NAME_KEY[row.id]);
  }
  const v = venue ?? venueCopy.forLocale('en').t;
  return v(VENUE_REFUSED_KEY[row.id]);
}
