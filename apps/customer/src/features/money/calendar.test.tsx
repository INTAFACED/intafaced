import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { ItemList, MonthGrid, Sources } from './Calendar';
import { bankReads, type CalendarItem, type CalendarView } from './contracts';

/** BK-acct-10 screen half (J-bank-06 #5): the money calendar's grid, list and source notes. */

const item = (patch: Partial<CalendarItem> = {}): CalendarItem => ({
  source: 'standing_orders',
  refId: 'S-1',
  key: 'S-1:0',
  date: '2026-11-20T09:00:00.000Z',
  label: null,
  assetId: 'USDT',
  amount: '25',
  status: 'upcoming',
  reasonCode: null,
  ...patch,
});

const view = (patch: Partial<CalendarView> = {}): CalendarView => ({
  from: '2026-11-01T00:00:00.000Z',
  to: '2026-12-01T00:00:00.000Z',
  items: [],
  sources: [
    { source: 'standing_orders', state: 'ok', count: 1, code: null, complete: true },
    { source: 'bills', state: 'ok', count: 0, code: 'bank.bills_psp_unset', complete: true },
    { source: 'direct_debits', state: 'ok', count: 1, code: null, complete: false },
    { source: 'loans', state: 'not_set', count: 2, code: 'bank.loan_schedule_unset', complete: true },
    { source: 'earn', state: 'unavailable', count: 0, code: 'bank.calendar_source_unavailable', complete: false },
  ],
  ...patch,
});

describe('the money calendar', () => {
  it('reads the bank answer as its schema', () => {
    expect(bankReads['calendar.window'].parse(view({ items: [item()] })).items[0]?.source).toBe('standing_orders');
  });

  it('puts each item on its day in a Monday-first grid, linked to its own room', () => {
    const html = renderToStaticMarkup(
      <MonthGrid
        month="2026-11"
        zone="UTC"
        items={[
          item(),
          item({
            source: 'direct_debits',
            refId: 'MD-1',
            key: 'C-row',
            date: '2026-11-03T00:00:00.000Z',
            label: 'TEST Gym',
            amount: '5',
            status: 'failed',
            reasonCode: 'bank.insufficient_funds',
          }),
          item({ source: 'earn', refId: 'P-1', key: 'P-1', date: '2026-11-25T00:00:00.000Z', amount: '50' }),
        ]}
      />,
    );
    // 1 November 2026 is a Sunday: six empty cells lead.
    expect(html.match(/bd-cal__day--pad/g)).toHaveLength(6);
    expect(html).toMatch(/data-testid="cal-day-20".*href="\/bank\/transfers"[^>]*>Standing order</);
    expect(html).toMatch(/data-testid="cal-day-3".*href="\/bank\/direct-debits"[^>]*>Direct debit: TEST Gym</);
    expect(html).toMatch(/data-testid="cal-day-25".*href="\/bank\/earn"[^>]*>Earn matures</);
    expect(html).toContain('data-status="failed"');
  });

  it('puts an instant on the day it falls on in the chosen zone', () => {
    const late = item({ key: 'S-1:9', date: '2026-11-03T20:00:00.000Z' });
    expect(renderToStaticMarkup(<MonthGrid month="2026-11" zone="UTC" items={[late]} />)).toMatch(/data-testid="cal-day-3".*S-1:9/);
    expect(renderToStaticMarkup(<MonthGrid month="2026-11" zone="UTC+8" items={[late]} />)).toMatch(/data-testid="cal-day-4".*S-1:9/);
  });

  it('names a run skipped while its order was paused', () => {
    expect(renderToStaticMarkup(<ItemList items={[item({ status: 'skipped', reasonCode: 'bank.schedule_paused' })]} />)).toContain(
      'Skipped because the order was paused.',
    );
  });

  it('lists each item with its status and the reason a run failed, by its code', () => {
    const html = renderToStaticMarkup(
      <ItemList items={[item({ status: 'failed', reasonCode: 'ledger.insufficient_funds' }), item({ key: 'S-1:1', status: 'paused' })]} />,
    );
    expect(html).toContain('Failed');
    expect(html).toContain('There was not enough money. Nothing was taken.');
    expect(html).toContain('Reference: ledger.insufficient_funds');
    expect(html).toContain('Paused');
  });

  it('names each source: loans without dates, bills without a partner, and a source that could not be read', () => {
    const html = renderToStaticMarkup(
      <Sources view={view({ items: [item(), item({ source: 'direct_debits', key: 'C-1', refId: 'MD-1', label: 'TEST Gym' })] })} />,
    );
    expect(html).toContain('Standing orders: 1 in this month.');
    expect(html).toContain('Direct debits: 1 in this month. Only the first 50 records were read, so later ones may be missing.');
    expect(html).toContain('Bills: no bill payment partner is connected');
    expect(html).toContain('Loans: repayment dates are not published, so no loan shows on the calendar. Open loans: 2.');
    expect(html).toContain('Fixed-term earn could not be read just now. Everything else is shown.');
    expect(html).toContain('Reference: bank.calendar_source_unavailable');
    expect(html).toMatch(/data-testid="cal-source-earn" data-state="unavailable" role="note"/);
  });
});
