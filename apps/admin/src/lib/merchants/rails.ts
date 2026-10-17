/**
 * Payment-rail ids as a founder should read them. The ids come from svc-pay's rail
 * registry; an id this console does not know is shown as the service sent it, never
 * guessed at. The founder read carries no rail mode, so a name never claims TEST or
 * live: the raw id (for example `card-sandbox`) is printed beside it.
 */
const RAIL_NAMES: Readonly<Record<string, string>> = {
  'crypto-native': 'Crypto transfers',
  'card-sandbox': 'Cards',
  'bank-payout': 'Bank payouts',
};

export function railName(railId: string): string {
  return RAIL_NAMES[railId] ?? railId;
}

export const RAIL_NO_REASON = 'The rail did not report a reason.';

/**
 * What to print in the Detail column. A rail that is down always says why: the
 * service's own reason when it sent one, otherwise a plain statement that it sent
 * none. A rail that is up with nothing to add stays a dash.
 */
export function railDetail(rail: { readonly ok: boolean; readonly detail: string | null }): string {
  const text = rail.detail?.trim() ?? '';
  if (text !== '') return text;
  return rail.ok ? '—' : RAIL_NO_REASON;
}
