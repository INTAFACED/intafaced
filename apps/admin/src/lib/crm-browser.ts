'use client';
import { CRM_NOT_CONFIGURED_TEXT, CRM_REFUSED_TEXT, crmRefusalKind, crmUpstreamCode, type CrmRefusalKind } from './crm-refusal';
/** Writes retain their request identity until a confirmed, validated receipt. */
export type PendingCrmWrite = { inputKey: string; requestId: string };
/** An input equal to this is replaced by the current time on every fetch, so "overdue" is measured when the data is read. */
export const AT_FETCH_TIME = '@now';
export function resolveFetchTime(input: Record<string, unknown>, now = new Date().toISOString()): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value === AT_FETCH_TIME ? now : value]));
}
/** A failed reload keeps what is on screen only when that value came from the very same request; otherwise it would be another filter's figures. */
export const readFailureKeepsValue = (shownUrl: string | null, url: string) => shownUrl !== null && shownUrl === url;
/** A refused CRM request, with what kind of refusal it was so a screen can drop actions that cannot help. */
export class CrmBrowserError extends Error {
  constructor(
    message: string,
    readonly kind: CrmRefusalKind,
  ) {
    super(message);
  }
}
export async function crmJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  if (!response.ok) {
    const kind = crmRefusalKind(response.status, crmUpstreamCode(await response.json().catch(() => null)));
    if (kind === 'unconfigured') throw new CrmBrowserError(CRM_NOT_CONFIGURED_TEXT, kind);
    if (kind === 'session') throw new CrmBrowserError('Your founder session is unavailable. Sign in again.', kind);
    if (kind === 'refused') throw new CrmBrowserError(CRM_REFUSED_TEXT, kind);
    if (kind === 'conflict')
      throw new CrmBrowserError('The record changed or this action was refused. Refresh and review before retrying.', kind);
    throw new CrmBrowserError('We could not confirm the request. Keep your entries and retry the same action.', kind);
  }
  return (await response.json()) as T;
}
export function workflowUrl(view: string, input: Record<string, unknown> = {}): string {
  const query = new URLSearchParams({ view });
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return `/api/crm/workflows?${query}`;
}
export async function crmWrite<T>(
  csrf: string,
  pending: Map<string, PendingCrmWrite>,
  action: string,
  input: Record<string, unknown>,
): Promise<T> {
  const inputKey = JSON.stringify(input),
    previous = pending.get(action);
  const requestId = previous?.inputKey === inputKey ? previous.requestId : crypto.randomUUID();
  pending.set(action, { inputKey, requestId });
  const result = await crmJson<T>('/api/crm/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
    body: JSON.stringify({ action, input: { ...input, requestId } }),
  });
  pending.delete(action);
  return result;
}
export const crmLabel = (value: string) => value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
// Day-month order and the founder's own clock, whatever the Mac's region setting: "15 Oct 2026, 10:53".
const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const TIME = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' });
const RELATIVE = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
export const crmDate = (value: string) => DATE_TIME.format(new Date(value));
export const crmTime = (value: string) => TIME.format(new Date(value));
/** "in 2 days", "yesterday", "3 hours ago": for due dates and ages, next to crmDate, never instead of it. */
export function crmRelative(value: string, now = Date.now()): string {
  const seconds = (Date.parse(value) - now) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size || unit === 'minute') return RELATIVE.format(Math.round(seconds / size), unit);
  return RELATIVE.format(0, 'minute');
}
/** Whole days a due date is past, or 0 when it is not overdue. */
export const crmOverdueDays = (value: string, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(value)) / 86400000));
/** Local calendar days between a due date and now: 0 for the same day, 1 for any time yesterday (even 10 minutes ago). */
export function crmOverdueCalendarDays(value: string, now = Date.now()): number {
  const startOfDay = (time: number) => {
    const day = new Date(time);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  };
  // Rounding absorbs the 23- and 25-hour days around a clock change.
  return Math.max(0, Math.round((startOfDay(now) - startOfDay(Date.parse(value))) / 86400000));
}
export const crmLocalDate = (value: string) =>
  new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
