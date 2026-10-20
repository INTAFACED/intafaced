/**
 * The one list of who has customer words for which service refusal code.
 *
 * The words themselves stay with the surface that shows them, because the same code can need different sentences on
 * different surfaces ("schedule" in a trading room, "bot" in the bots room). What lives here is the question every
 * surface shares: does this code have words anywhere, and where? `refusal-catalogue.test.ts` holds it against the
 * services' own error files, so a code a service adds and nobody words fails a test instead of reaching a screen as a
 * generic line.
 *
 * Nothing on a screen reads this file; it is the test and review surface for the catalogues.
 */
import { classifyRefusal, SHARED_REFUSAL_CODES } from '../data/refusal-codes';
import { MONEY_REFUSAL_CODES } from '../features/money/money-refusal-copy';
import { SUPPORT_REFUSAL_CODES } from '../features/more/support-refusal';
// These register their words with the portal table when they load, so each is loaded here before the table is read.
import '../features/pay/portal/access/step-up-words';
import '../features/pay/portal/money/refusals';
import '../features/pay/portal/payments/refusals';
import '../features/pay/portal/settings/account/refusals';
import '../features/pay/portal/settings/developers/copy';
import '../features/pay/portal/settings/reports/copy';
import { knownRefusalCodes } from '../features/pay/portal/refusal';
import { COPY_BOTS_REFUSAL_CODES } from '../screens/trade/copybots/refusals';
import { FUTURES_REFUSAL_CODES } from '../screens/trade/futures/refusals';
import { ROOMS_REFUSAL_CODES } from '../screens/trade/rooms/refusals';

export type RefusalCatalogueId = 'shared' | 'tradeRooms' | 'futures' | 'copyBots' | 'bankMoney' | 'payPortal' | 'support';

const normal = (code: string) => code.trim().toLowerCase();
const listed = (codes: readonly string[]) => new Set(codes.map(normal));

/** Catalogues that name their codes one by one. */
const LISTS: ReadonlyArray<readonly [RefusalCatalogueId, () => ReadonlySet<string>]> = [
  ['shared', () => listed(SHARED_REFUSAL_CODES)],
  ['tradeRooms', () => listed(ROOMS_REFUSAL_CODES)],
  ['futures', () => listed(FUTURES_REFUSAL_CODES)],
  ['copyBots', () => listed(COPY_BOTS_REFUSAL_CODES)],
  ['bankMoney', () => listed(MONEY_REFUSAL_CODES)],
  ['payPortal', () => listed(knownRefusalCodes())],
  ['support', () => listed(SUPPORT_REFUSAL_CODES)],
];

/** Which catalogues have words for this code. Empty means a customer would meet the generic line. */
export function refusalCatalogues(code: string): RefusalCatalogueId[] {
  const key = normal(code);
  const owners: RefusalCatalogueId[] = [];
  for (const [id, codes] of LISTS) if (codes().has(key)) owners.push(id);
  // The shared catalogue also answers by prefix and suffix (`denied.*`, `*_unset`).
  if (!owners.includes('shared') && classifyRefusal(key) !== 'unknown') owners.unshift('shared');
  return owners;
}

export const isRefusalCatalogued = (code: string): boolean => refusalCatalogues(code).length > 0;

/** Every code a catalogue names one by one, with its owners. The shared catalogue's prefix and suffix rules are not enumerable. */
export function listedRefusalCodes(): Map<string, RefusalCatalogueId[]> {
  const all = new Map<string, RefusalCatalogueId[]>();
  for (const [id, codes] of LISTS) for (const code of codes()) all.set(code, [...(all.get(code) ?? []), id]);
  return all;
}
