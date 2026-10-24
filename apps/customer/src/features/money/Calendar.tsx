import { useState, type ReactNode } from 'react';
import { currentPreferences } from '../../shared/preferences';
import { EmptyState, Failure, Loading } from '../../shared/ui';
import { amount, date, useBankRead } from './components';
import { calendarSources, type CalendarItem, type CalendarSource, type CalendarView } from './contracts';
import { DepthPanel } from './DepthParts';
import { calendarCopy } from './calendar-copy';
import './bank-depth.css';

/**
 * `/bank/calendar` (J-bank-06 #5, BK-acct-10): one calendar of what is dated in a month, from standing orders, bills,
 * direct debits, loans and fixed-term earn, in a month grid or a list, filtered by kind. Each item opens its own room. A
 * source that could not be read says so and the others still show; loans publish no repayment dates, and the page says
 * that rather than showing an empty kind as if nothing were due. Read only.
 */

type Copy = ReturnType<typeof calendarCopy.useCopy>['t'];

/** Where each kind of item is changed. Loans have no dated items, so they never link from a day. */
const ROOM: Record<Exclude<CalendarSource, 'loans'>, string> = {
  standing_orders: '/bank/transfers',
  bills: '/pay/bills',
  direct_debits: '/bank/direct-debits',
  earn: '/bank/earn',
};

const PAGE = 50;

type Zone = ReturnType<typeof currentPreferences>['timeZone'];

/** The day an instant falls on in the person's chosen zone, `YYYY-MM-DD`: the grid, the list and the month all use it. */
export function dayIn(iso: string | Date, zone: Zone): string {
  const timeZone = zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** The UTC dates to ask for so every instant of `month` in any zone is inside: a day either side. */
function windowFor(month: string): { from: string; days: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10), days: daysIn(month) + 2 };
}

function shift(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function reasonOf(t: Copy, code: string | null): string {
  switch (code) {
    case null:
      return '';
    case 'bank.insufficient_funds':
    case 'ledger.insufficient_funds':
    case 'bank.bills_insufficient_funds':
      return t('reason_insufficient');
    case 'bank.dd_mandate_blocked':
      return t('reason_blocked');
    case 'bank.dd_account_unavailable':
      return t('reason_account');
    case 'bank.space_locked':
      return t('reason_locked');
    case 'bank.schedule_paused':
      return t('reason_paused');
    default:
      return t('reason_other');
  }
}

function what(t: Copy, item: CalendarItem): string {
  switch (item.source) {
    case 'bills':
      return t('item_bills', { label: item.label ?? '' });
    case 'direct_debits':
      return t('item_direct_debits', { label: item.label ?? '' });
    case 'earn':
      return t('item_earn');
    default:
      return t('item_standing_orders');
  }
}

function roomOf(item: CalendarItem): string | null {
  return item.source === 'loans' ? null : ROOM[item.source];
}

function Status({ item }: { item: CalendarItem }) {
  const { t } = calendarCopy.useCopy();
  return (
    <span data-status={item.status}>
      {t(`status_${item.status}`)}
      {item.reasonCode && (
        <>
          {' '}
          <small className="muted">
            {reasonOf(t, item.reasonCode)} {t('reference', { code: item.reasonCode })}
          </small>
        </>
      )}
    </span>
  );
}

function ItemLink({ item, children }: { item: CalendarItem; children: ReactNode }) {
  const room = roomOf(item);
  return room ? (
    <a className="text-link" href={room} data-testid={`cal-open-${item.key}`}>
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

export function MonthGrid({ month, items, zone }: { month: string; items: readonly CalendarItem[]; zone: Zone }) {
  const { t } = calendarCopy.useCopy();
  const [y, m] = month.split('-').map(Number) as [number, number];
  // Monday first: getUTCDay is 0 for Sunday.
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = daysIn(month);
  const byDay = new Map<number, CalendarItem[]>();
  for (const item of items) {
    const day = Number(dayIn(item.date, zone).slice(8, 10));
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  const cells: Array<number | null> = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <div className="bd-cal" role="grid" aria-label={monthName(month)} data-testid="cal-month">
      <div className="bd-cal__row" role="row">
        {t('weekdays')
          .split(',')
          .map((name) => (
            <div key={name} className="bd-cal__head" role="columnheader">
              {name}
            </div>
          ))}
      </div>
      <div className="bd-cal__days">
        {cells.map((day, i) =>
          day === null ? (
            <div key={`pad-${i}`} className="bd-cal__day bd-cal__day--pad" aria-hidden="true" />
          ) : (
            <div key={day} className="bd-cal__day" role="gridcell" data-testid={`cal-day-${day}`}>
              <span className="bd-cal__date">{day}</span>
              {(byDay.get(day) ?? []).map((item) => (
                <div key={item.key} className="bd-cal__item" data-status={item.status} data-source={item.source}>
                  <ItemLink item={item}>{what(t, item)}</ItemLink>
                  <span className="money-caption">
                    {item.amount ? amount(item.amount, item.assetId) : null} · {t(`status_${item.status}`)}
                  </span>
                </div>
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function ItemList({ items }: { items: readonly CalendarItem[] }) {
  const { t } = calendarCopy.useCopy();
  return (
    <div className="withdrawal-address-scroll">
      <table className="bd-table" data-testid="cal-list">
        <thead>
          <tr>
            <th scope="col">{t('colDate')}</th>
            <th scope="col">{t('colWhat')}</th>
            <th scope="col" className="bd-num">
              {t('colAmount')}
            </th>
            <th scope="col">{t('colStatus')}</th>
            <th scope="col">{t('colOpen')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} data-testid={`cal-row-${item.key}`} data-source={item.source}>
              <td>{date(item.date)}</td>
              <td lang={item.label ? 'und' : undefined}>{what(t, item)}</td>
              <td className="bd-num">{item.amount ? amount(item.amount, item.assetId) : null}</td>
              <td>
                <Status item={item} />
              </td>
              <td>
                <ItemLink item={item}>{t('openItem')}</ItemLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How each source answered. `items` are the ones in the month shown, so an `ok` count is this month's. */
export function Sources({ view, items = view.items }: { view: CalendarView; items?: readonly CalendarItem[] }) {
  const { t } = calendarCopy.useCopy();
  return (
    <ul className="bd-stack" data-testid="cal-sources">
      {view.sources.map((s) => {
        const name = t(`source_${s.source}`);
        const count = items.filter((i) => i.source === s.source).length;
        let words: string;
        if (s.state === 'not_set') words = t('sourceNotSet_loans', { count: String(s.count) });
        else if (s.state === 'refused') words = t('sourceRefused', { source: name });
        else if (s.state === 'unavailable') words = t('sourceUnavailable', { source: name });
        else if (s.code === 'bank.bills_psp_unset' && count === 0) words = t('billsNoPartner');
        else words = t('sourceOk', { source: name, count: String(count) });
        if (!s.complete && s.state !== 'refused' && s.state !== 'unavailable')
          words = `${words} ${t('sourcePartial', { limit: String(PAGE) })}`;
        return (
          <li key={s.source} data-testid={`cal-source-${s.source}`} data-state={s.state} role={s.state === 'ok' ? undefined : 'note'}>
            {words} {s.code && <small className="muted">{t('reference', { code: s.code })}</small>}
          </li>
        );
      })}
    </ul>
  );
}

export function MoneyCalendar({ now = new Date() }: { now?: Date }) {
  const { t } = calendarCopy.useCopy();
  const zone = currentPreferences().timeZone;
  const [month, setMonth] = useState(() => dayIn(now, zone).slice(0, 7));
  const [view, setView] = useState<'month' | 'list'>('month');
  const [hidden, setHidden] = useState<ReadonlySet<CalendarSource>>(new Set());
  const read = useBankRead('calendar.window', { ...windowFor(month), limit: PAGE });
  const toggle = (source: CalendarSource) =>
    setHidden((was) => {
      const next = new Set(was);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  return (
    <div className="bd-stack">
      <p role="note">{t('readOnly')}</p>
      <div className="actions" role="group" aria-label={monthName(month)}>
        <button type="button" className="bd-chip" onClick={() => setMonth((m) => shift(m, -1))}>
          {t('prev')}
        </button>
        <strong data-testid="cal-month-name" data-month={month}>
          {monthName(month)}
        </strong>
        <button type="button" className="bd-chip" onClick={() => setMonth((m) => shift(m, 1))}>
          {t('next')}
        </button>
        <button type="button" className="bd-chip" aria-pressed={view === 'month'} onClick={() => setView('month')}>
          {t('monthView')}
        </button>
        <button type="button" className="bd-chip" aria-pressed={view === 'list'} onClick={() => setView('list')}>
          {t('listView')}
        </button>
      </div>
      <div className="actions" role="group" aria-label={t('filterLabel')}>
        <span className="money-caption">{t('filterLabel')}</span>
        {calendarSources
          .filter((s) => s !== 'loans')
          .map((source) => (
            <button key={source} type="button" className="bd-chip" aria-pressed={!hidden.has(source)} onClick={() => toggle(source)}>
              {t(`source_${source}`)}
            </button>
          ))}
      </div>
      {read.resource.status === 'loading' ? (
        <Loading />
      ) : read.resource.status === 'failed' ? (
        <Failure result={read.resource.failure} retry={read.reload} />
      ) : (
        <>
          {(() => {
            const data = read.resource.data;
            const inMonth = data.items.filter((i) => dayIn(i.date, zone).startsWith(month));
            const items = inMonth.filter((i) => !hidden.has(i.source));
            if (items.length === 0) {
              // Never claim an empty month the page cannot know is empty: a kind that was hidden or could not be read
              // may hold something.
              const unread = data.sources.some((s) => s.state === 'refused' || s.state === 'unavailable');
              const body = inMonth.length > 0 ? t('emptyFiltered') : unread ? t('emptyPartial') : t('emptyBody');
              return (
                <EmptyState title={inMonth.length > 0 || unread ? t('emptyShown') : t('empty', { month: monthName(month) })}>
                  <p>{body}</p>
                </EmptyState>
              );
            }
            return view === 'month' ? <MonthGrid month={month} items={items} zone={zone} /> : <ItemList items={items} />;
          })()}
          <DepthPanel title={t('sourcesTitle')}>
            <Sources view={read.resource.data} items={read.resource.data.items.filter((i) => dayIn(i.date, zone).startsWith(month))} />
          </DepthPanel>
        </>
      )}
      <p>
        <a className="text-link" href="/bank/transfers">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
