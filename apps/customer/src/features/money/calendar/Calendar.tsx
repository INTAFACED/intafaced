// volt-room: /bank/calendar
import { useState, type ReactNode } from 'react';
import { Button, EmptyState, Segmented } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { currentPreferences } from '../../../shared/preferences';
import { amount, date, useBankRead } from '../components';
import { calendarSources, type CalendarItem, type CalendarSource, type CalendarView } from '../contracts';
import { BankTabs, bankRoomProps } from '../bank-frame/BankFrame';
import { Failure, Loading, Panel } from '../bank-settings/parts';
import { calendarCopy } from '../calendar-copy';

/** `/bank/calendar`: everything dated, inside the Transfers room (J-bank-06 #5), on the monitor template. */
export function CalendarRoom() {
  const { t } = calendarCopy.useCopy();
  return (
    <MonitorTemplate
      {...bankRoomProps('Transfers', t('description'), t('title'))}
      state={{ kind: 'ready' }}
      mode="pro"
      figures={[]}
      section={<BankTabs />}
      panels={<MoneyCalendar />}
    />
  );
}

/**
 * The calendar (J-bank-06 #5, BK-acct-10): one calendar of what is dated in a month, from standing orders, bills,
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
function dayIn(iso: string | Date, zone: Zone): string {
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
    case 'bank.partner_insufficient_funds':
      return t('reason_insufficient');
    case 'bank.dd_mandate_blocked':
    case 'test_partner.dd_mandate_blocked':
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
    // The reason's code is the item's attribute, never words a customer reads.
    <span data-status={item.status} data-code={item.reasonCode ?? undefined}>
      {t(`status_${item.status}`)}
      {item.reasonCode && (
        <>
          {' '}
          <small className="lt-hint">{reasonOf(t, item.reasonCode)}</small>
        </>
      )}
    </span>
  );
}

function ItemLink({ item, children }: { item: CalendarItem; children: ReactNode }) {
  const room = roomOf(item);
  return room ? (
    <a className="lt-link" href={room} data-testid={`cal-open-${item.key}`}>
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
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  return (
    <table className="lt-table" role="grid" aria-label={monthName(month)} data-testid="cal-month">
      <thead>
        <tr>
          {t('weekdays')
            .split(',')
            .map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, w) => (
          <tr key={w}>
            {week.map((day, i) =>
              day === null ? (
                <td key={`pad-${i}`} data-pad="" aria-hidden="true" />
              ) : (
                <td key={day} role="gridcell" data-testid={`cal-day-${day}`}>
                  <div className="lt-stack">
                    <strong>{day}</strong>
                    {(byDay.get(day) ?? []).map((item) => (
                      <div key={item.key} className="lt-lines" data-status={item.status} data-source={item.source}>
                        <ItemLink item={item}>{what(t, item)}</ItemLink>
                        <span className="lt-hint">
                          {item.amount ? amount(item.amount, item.assetId) : null} · {t(`status_${item.status}`)}
                        </span>
                      </div>
                    ))}
                  </div>
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ItemList({ items }: { items: readonly CalendarItem[] }) {
  const { t } = calendarCopy.useCopy();
  return (
    <div role="region" aria-label={t('listView')} tabIndex={0}>
      <table className="lt-table" data-testid="cal-list">
        <thead>
          <tr>
            <th scope="col">{t('colDate')}</th>
            <th scope="col">{t('colWhat')}</th>
            <th scope="col">{t('colAmount')}</th>
            <th scope="col">{t('colStatus')}</th>
            <th scope="col">{t('colOpen')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} data-testid={`cal-row-${item.key}`} data-source={item.source}>
              <td data-label={t('colDate')}>{date(item.date)}</td>
              <td lang={item.label ? 'und' : undefined} data-label={t('colWhat')}>
                {what(t, item)}
              </td>
              <td className="lt-mono" data-label={t('colAmount')}>
                {item.amount ? amount(item.amount, item.assetId) : null}
              </td>
              <td data-label={t('colStatus')}>
                <Status item={item} />
              </td>
              <td data-label={t('colOpen')}>
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
    <ul className="lt-rows" data-testid="cal-sources">
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
          // The source's code is the row's attribute, never words a customer reads.
          <li
            key={s.source}
            data-testid={`cal-source-${s.source}`}
            data-state={s.state}
            data-code={s.code ?? undefined}
            role={s.state === 'ok' ? undefined : 'note'}
          >
            {words}
          </li>
        );
      })}
    </ul>
  );
}

function MoneyCalendar({ now = new Date() }: { now?: Date }) {
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
    <div className="lt-stack">
      <p role="note">{t('readOnly')}</p>
      {/* The month's name, then its two buttons, then the view switch: each on its own line, so a phone never scatters
          them into a grid. */}
      <strong data-testid="cal-month-name" data-month={month}>
        {monthName(month)}
      </strong>
      <div className="lt-actions" role="group" aria-label={monthName(month)}>
        <Button tone="secondary" onClick={() => setMonth((m) => shift(m, -1))}>
          {t('prev')}
        </Button>
        <Button tone="secondary" onClick={() => setMonth((m) => shift(m, 1))}>
          {t('next')}
        </Button>
      </div>
      <Segmented
        label={t('viewLabel')}
        value={view}
        onChange={setView}
        options={[
          { value: 'month', label: t('monthView') },
          { value: 'list', label: t('listView') },
        ]}
      />
      <div className="lt-actions" role="group" aria-label={t('filterLabel')}>
        <span className="lt-hint">{t('filterLabel')}</span>
        {calendarSources
          .filter((s) => s !== 'loans')
          .map((source) => (
            <Button key={source} tone="secondary" aria-pressed={!hidden.has(source)} onClick={() => toggle(source)}>
              {t(`source_${source}`)}
            </Button>
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
                <EmptyState title={inMonth.length > 0 || unread ? t('emptyShown') : t('empty', { month: monthName(month) })} body={body} />
              );
            }
            return view === 'month' ? <MonthGrid month={month} items={items} zone={zone} /> : <ItemList items={items} />;
          })()}
          <Panel level={3} title={t('sourcesTitle')}>
            <Sources view={read.resource.data} items={read.resource.data.items.filter((i) => dayIn(i.date, zone).startsWith(month))} />
          </Panel>
        </>
      )}
      <p>
        <a className="lt-link" href="/bank/transfers">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
