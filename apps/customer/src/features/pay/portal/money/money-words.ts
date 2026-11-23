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
