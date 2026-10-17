import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { plainCode } from './plain-code';
import { PortalFailure } from '../components';
import { isNotLive, knownRefusalCodes, refusalText, registerNotLive, registerRefusals } from '../refusal';
import { AuditPanel } from './AuditPanel';
import { CopyReference } from './CopyReference';
import { DateTime, formatDateTime } from './DateTime';
import { DetailHeader } from './DetailHeader';
import { EntityList } from './EntityList';
import { countText, dateRange } from './FilterRow';
import { ageSeconds } from './Freshness';
import { KpiStrip, KPI_MAX } from './Kpi';
import { MoneyText } from './MoneyText';
import { pageOrArray, pagedResult } from './page';
import { RelatedLinks } from './RelatedLinks';
import { StatusChip } from './StatusChip';
import { uiCopy } from './copy';

// TEST DATA only.
describe('StatusChip', () => {
  it('shows the word, the explanation and a tone, for old and new entities', () => {
    const paid = renderToString(<StatusChip entity="payment" value="captured" />);
    expect(paid).toContain('Paid');
    expect(paid).toContain('pp-chip--done');
    expect(renderToString(<StatusChip entity="invoice" value="draft" />)).toContain('Draft');
    expect(renderToString(<StatusChip entity="refund" value="failed" />)).toContain('pp-chip--failed');
    expect(renderToString(<StatusChip entity="payout" value="awaiting_approval" />)).toContain('pp-chip--action');
  });
  it('never uses the lime status tag', () => {
    expect(renderToString(<StatusChip entity="payment" value="settled" />)).not.toContain('status-tag');
  });
  it('shows a status it does not know as the service sent it, in the quiet tone', () => {
    const out = renderToString(<StatusChip entity="invoice" value="mystery" />);
    expect(out).toContain('mystery');
    expect(out).toContain('pp-chip--progress');
  });
});

describe('DateTime', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  it('is short in this year and carries the year in another', () => {
    expect(formatDateTime('2026-10-15T14:40:00Z', 'en', now, 'UTC')?.short).toBe('Oct 15, 2:40 PM');
    expect(formatDateTime('2025-10-15T14:40:00Z', 'en', now, 'UTC')?.short).toBe('Oct 15, 2025, 2:40 PM');
  });
  it('keeps the full date, time and zone in the tooltip', () => {
    expect(formatDateTime('2026-10-15T14:40:00Z', 'en', now, 'UTC')?.full).toMatch(/Thursday, October 15, 2026.*UTC/);
  });
  it('shows something that is not a timestamp as it came, and never throws', () => {
    expect(formatDateTime('soon', 'en')).toBeNull();
    expect(renderToString(<DateTime value="soon" />)).toContain('soon');
    expect(renderToString(<DateTime value="2026-10-15T14:40:00Z" timeZone="UTC" />)).toMatch(/datetime="2026-10-15T14:40:00Z"/i);
  });
});

describe('MoneyText', () => {
  it('is exact, with its asset, on one line', () => {
    const out = renderToString(<MoneyText value="12.345678" asset="USDT" />);
    expect(out).toContain('12.345678');
    expect(out).toContain('USDT');
    expect(out).toContain('pp-nowrap');
  });
  it('drops a zero line when asked, and tags test money', () => {
    expect(renderToString(<MoneyText value="0" asset="USD" hideZero />)).toBe('');
    expect(renderToString(<MoneyText value="1" asset="USD" test />)).toContain('TEST');
    expect(renderToString(<MoneyText value="1" asset="USD" />)).not.toContain('TEST');
  });
});

describe('freshness', () => {
  it('adds the lag the service reported to the time since the read', () => {
    const asOf = '2026-10-17T10:00:00.000Z';
    expect(ageSeconds(asOf, Date.parse('2026-10-17T10:02:00.000Z'))).toBe(120);
    expect(ageSeconds(asOf, Date.parse('2026-10-17T10:02:00.000Z'), 30)).toBe(150);
    expect(ageSeconds(asOf, Date.parse('2026-10-17T09:00:00.000Z'))).toBe(0);
  });
});

describe('KpiStrip', () => {
  const tile = (n: number) => ({ label: `Tile ${n}`, period: 'Last 7 days', href: `/pay/payments?status=captured&n=${n}`, value: n });
  it('names every tile’s period and links it to the list it counts', () => {
    const out = renderToString(<KpiStrip label="Payments" tiles={[tile(1), tile(2), tile(3), tile(4)]} />);
    expect(out.match(/Last 7 days/g)).toHaveLength(4);
    expect(out.match(/href="\/pay\/payments/g)).toHaveLength(4);
  });
  it('shows at most eight', () => {
    const out = renderToString(<KpiStrip label="Payments" tiles={Array.from({ length: 12 }, (_, i) => tile(i))} />);
    expect(out.match(/pp-kpi--link/g)).toHaveLength(KPI_MAX);
  });
});

describe('EntityList', () => {
  const rows = [{ id: 'a', name: 'TEST order', amount: '10', status: 'captured' }];
  const list = (withHref: boolean) =>
    renderToString(
      <EntityList
        label="Payments"
        rows={rows}
        rowKey={(r) => r.id}
        columns={[{ header: 'Payment', cell: (r) => r.name }]}
        card={(r) => ({ title: r.name, amount: r.amount, status: <StatusChip entity="payment" value={r.status} /> })}
        href={withHref ? (r) => `/pay/payments/${r.id}` : undefined}
      />,
    );
  it('draws a table and two-line cards, each opening the detail', () => {
    const out = list(true);
    expect(out).toContain('pe-table');
    expect(out).toContain('pe-cards');
    expect(out.match(/href="\/pay\/payments\/a"/g)).toHaveLength(2);
    expect(out).toContain('>Open<');
  });
  it('has no links on a summary list', () => {
    const out = list(false);
    expect(out).not.toContain('href=');
    expect(out).not.toContain('>Open<');
  });
});

describe('filters', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');
  it('turns a date choice into bounds, and leaves an open end open', () => {
    expect(dateRange('today', now)).toEqual({ from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' });
    expect(dateRange('7d', now).from).toBe('2026-10-11T00:00:00.000Z');
    expect(dateRange('30d', now).from).toBe('2026-09-18T00:00:00.000Z');
    expect(dateRange('', now)).toEqual({});
    expect(dateRange('custom', now, { from: '2026-10-01', to: '' })).toEqual({ from: '2026-10-01T00:00:00.000Z' });
    expect(dateRange('custom', now, { from: '', to: '2026-10-05' })).toEqual({ to: '2026-10-06T00:00:00.000Z' });
  });
  it('counts honestly: a total only if the service gave one', () => {
    const { t } = uiCopy.forLocale('en');
    expect(countText(t, 25, true)).toBe('Newest 25 · Load more');
    expect(countText(t, 9, false)).toBe('Newest 9');
    expect(countText(t, 25, true, 313)).toBe('313 results');
  });
});

describe('pages and arrays', () => {
  it('reads an array and a page the same way', () => {
    expect(pageOrArray([1, 2])).toEqual({ items: [1, 2], nextCursor: null });
    expect(pageOrArray({ items: [1], nextCursor: 'c2' })).toEqual({ items: [1], nextCursor: 'c2' });
    expect(pageOrArray({ items: [1] })).toEqual({ items: [1], nextCursor: null });
  });
  it('passes a refusal through untouched', () => {
    const failed = { ok: false as const, reason: 'error' as const, message: 'x' };
    expect(pagedResult<number>(failed)).toBe(failed);
  });
});

describe('detail building blocks', () => {
  it('puts the amount and status in the title, with a way back', () => {
    const out = renderToString(
      <DetailHeader back={{ href: '/pay/payments', label: 'Back to payments' }} title="47.13 USDT" status="Paid" subtitle="TEST order" />,
    );
    expect(out).toContain('47.13 USDT');
    expect(out).toContain('href="/pay/payments"');
  });
  it('says who last changed a record, or that it is not recorded', () => {
    expect(renderToString(<AuditPanel who="Sam" at="2026-10-15T14:40:00Z" />)).toContain('Last changed by Sam');
    expect(renderToString(<AuditPanel who={null} at={null} />)).toContain('isn’t recorded');
  });
  it('lists related pages only when there are some', () => {
    expect(renderToString(<RelatedLinks links={[]} />)).toBe('');
    expect(renderToString(<RelatedLinks links={[{ href: '/pay/payments/a', label: 'Original payment' }]} />)).toContain('Original payment');
  });
  it('announces copying through a status region', () => {
    const out = renderToString(<CopyReference value="TEST-ref" what="reference" />);
    expect(out).toContain('TEST-ref');
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-label="Copy reference"');
  });
});

describe('failures and refusals', () => {
  const failure = (patch: object = {}) => ({ ok: false as const, reason: 'error' as const, message: 'x', ...patch });
  it('shows a reference only when the service sent one', () => {
    expect(renderToString(<PortalFailure result={failure({ requestId: 'req-TEST-1' })} />)).toContain('req-TEST-1');
    expect(renderToString(<PortalFailure result={failure()} />)).not.toContain('Reference');
  });
  it('lets a package word its own codes, and refuses a code twice', () => {
    registerRefusals({ 'pay.test_only_code': () => 'That only happens in a test.' });
    expect(refusalText(failure({ code: 'pay.test_only_code' }))).toBe('That only happens in a test.');
    expect(() => registerRefusals({ 'pay.test_only_code': () => 'again' })).toThrow(/twice/);
    expect(() => registerRefusals({ 'pay.dispute_closed': () => 'again' })).toThrow(/twice/);
    expect(new Set(knownRefusalCodes()).size).toBe(knownRefusalCodes().length);
  });
  it('shows a switched-off feature as a card that names what it is waiting for', () => {
    registerNotLive({ 'pay.test_feature_off': () => 'Waiting for the TEST thing' });
    expect(isNotLive(failure({ code: 'pay.test_feature_off' }))).toBe(true);
    expect(isNotLive(failure({ code: 'pay.dispute_closed' }))).toBe(false);
    expect(renderToString(<PortalFailure result={failure({ code: 'pay.test_feature_off' })} />)).toContain('Waiting for the TEST thing');
    expect(renderToString(<PortalFailure result={failure({ code: 'pay.test_feature_off' })} notLive="Page-specific reason" />)).toContain(
      'Page-specific reason',
    );
    expect(renderToString(<PortalFailure result={failure({ code: 'pay.not_built' })} />)).toContain('INTAFACED hasn’t switched this on');
  });
});

describe('plainCode', () => {
  it('says a code as words, and leaves a scheme number alone', () => {
    expect(plainCode('product_not_received')).toBe('Product not received');
    expect(plainCode('4853')).toBe('4853');
    expect(plainCode('fraudulent')).toBe('fraudulent');
  });
});
