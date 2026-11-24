// The only file in this screen that knows where the shared data pieces come from: the data layer in ../../data and the
// feature registry (same arrangement as screens/home/deps.ts). The old kit's parts the rooms not yet in Volt draw are in
// ./ui-deps.ts, so a room in Volt reaches this file without reaching the old kit.

export { fmtAmount, fmtChangeLine, fmtPct, fmtUsd, refusalCopy, useMarkets, useTickers } from '../../data';
export type { Decimal, Loadable, MarketRow } from '../../data';
export type { BalanceEntry } from '../../data/derive';
// The activity hook is a new file in the data layer (not yet in the data barrel).
export { ACTIVITY_KINDS, ACTIVITY_PAGE_SIZE, useActivity } from '../../data/activity';
export type { ActivityFeed, ActivityItem, ActivityKind } from '../../data/activity';
export { dec, decOrNull, roundScaled, SCALE, str, toFixedString } from '../../data/decimal';
export { primarySymbolFor } from '../../data/derive';

export { isHiddenPath } from '../../app/feature-registry';
export { coinHref, defaultDeskPair } from '../../app/navigation';
export { navigate } from '../../app/location';
export { quotePlaces } from '../trade/desk/text';
