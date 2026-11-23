import type { ApiResult } from '../../../../shared/api';
import { formatDay } from '../ui/format';
import type { mc } from './copy';

/** The service allows one statement scan per merchant at a time; a second call is refused as busy. */
export function isStatementBusy(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  const code = result.code?.startsWith('pay.') ? result.code : (/^(pay\.[a-z0-9_]+)/.exec(result.message)?.[1] ?? result.code ?? '');
  return code === 'pay.statement_busy';
}

/**
 * "Payout to ••4421 · Oct 15": named by where it went and the day its settlement was finalised, on every page. With no
 * date to hand the name drops it ("Payout to ••4421") rather than borrowing a different day, such as the day it was asked for.
 */
export function payoutName(
  t: ReturnType<typeof mc.useCopy>['t'],
  locale: string,
  row: { createdAt?: string | null },
  approval?: { destinationMasked?: string } | null,
): string {
  const to = approval?.destinationMasked;
  if (!row.createdAt) return to ? t('payoutNameToBare', { to }) : t('payoutNameBare');
  const when = shortDay(row.createdAt, locale);
  return to ? t('payoutNameTo', { to, when }) : t('payoutNamePlain', { when });
}

/** "Oct 15, 2026", in the browser's time zone (the same day the list shows for this row). */
export function shortDay(value: string, locale: string): string {
  return formatDay(value, locale) ?? value;
}

/** A person's name: "You" for the signed-in user, their team name where the list has it, otherwise a short id. */
export function whoIs(id: string, me: string | null, names: ReadonlyMap<string, string>, you: string): string {
  if (id === me) return you;
  return names.get(id) ?? `${id.slice(0, 8)}…`;
}

/** A refusal this page words itself (an address that cannot be right), shaped like a service refusal. */
export function localRefusal(message: string): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason: 'error', code: 'portal.local', message };
}
