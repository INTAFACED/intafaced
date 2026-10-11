import { useLayoutEffect, useMemo, useRef } from 'react';
import { z } from 'zod';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { Text } from './copy';

/** A reference identifies one record in the current owner response. This
 * protects against ambiguous/case-varied rows; producer ownership stays required. */
export function currentOwnerRecord<T extends { id: string }>(rows: readonly T[], id: string) {
  if (!z.string().uuid().safeParse(id).success) return undefined;
  const matches = rows.filter((row) => row.id.toLowerCase() === id.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/** Callbacks retire with their rendered owner/session/URL view. MoneyRooms'
 * existing synchronous URL observer also retires a batched departure/return.
 * canWrite is the API's identity lease, not permission to dispatch a bank action. */
export function useBankView() {
  const { api, userId } = useSession();
  const mounted = useRef(false);
  const view = { api, userId, href: location.href };
  const latest = useRef(view);
  // Publish the lease with the committed handlers. A discarded render must not
  // retire the still-visible controls (for example, a same-value state update).
  // Immediate URL/API retirement still belongs to MoneyRooms and api.canWrite.
  useLayoutEffect(() => {
    latest.current = view;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => mounted.current && latest.current === view && location.href === view.href && !!userId && api.canWrite();
}

/** Returned timestamps use the actual requested formatter locale, independently
 * of authored-copy fallback. Direction isolation preserves localized date order. */
export function ReportedTime({ value }: { value: string }) {
  const { language, timeZone } = usePreferences();
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        ...(timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Etc/GMT-8' : 'UTC' }),
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }),
    [language, timeZone],
  );
  return Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value} lang={formatter.resolvedOptions().locale} dir="auto">
      {formatter.format(new Date(value))}
    </time>
  ) : (
    <Text k="components.date.unavailable" />
  );
}
