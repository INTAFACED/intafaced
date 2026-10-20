import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../shared/api';
import { submitActive, submitDelete, submitEdit } from './alerts-actions';
import { activeWords, canEdit, DEFAULT_VIEW, editDiff, editStart, settleFailure, visibleAlerts } from './alerts-model';
import { listAlertTriggers, type PriceAlert } from './notify-api';

const USER = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';
const row = (patch: Partial<PriceAlert> = {}): PriceAlert => ({
  id: ID,
  userId: USER,
  marketId: 'm1',
  kind: 'price',
  direction: 'above',
  targetPrice: '65000.50',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  condition: 'greater_than',
  name: 'Breakout',
  message: null,
  expiresAt: null,
  extras: [],
  ...patch,
});
const trpc = (data: unknown, status = 200) => new Response(JSON.stringify({ result: { data } }), { status });
const trpcError = (status: number, message: string, code: string) =>
  new Response(JSON.stringify({ error: { message, code: -32600, data: { code } } }), { status });
const client = (fetch: typeof globalThis.fetch) => createApiClient({ fetch, token: () => 'tok' });
const body = (fetch: ReturnType<typeof vi.fn>) => JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));

describe('what an edit changes', () => {
  it('sends only the fields the person changed, and never a price spelled differently', () => {
    const start = editStart(row());
    expect(editDiff(row(), start)).toEqual({});
    expect(editDiff(row(), { ...start, price: '65000.5' })).toEqual({});
    expect(editDiff(row(), { ...start, price: ' 70000 ' })).toEqual({ targetPrice: '70000' });
    expect(editDiff(row(), { ...start, condition: 'crossing_up' })).toEqual({ condition: 'crossing_up' });
  });
  it('sends null to clear a name, a message or a stop time', () => {
    const withAll = row({ message: 'Look', expiresAt: '2026-11-01T10:00:00.000Z' });
    const start = editStart(withAll);
    expect(editDiff(withAll, { ...start, name: '  ', message: '', expires: '' })).toEqual({ name: null, message: null, expiresAt: null });
  });
  it('reads a stop time back in the same spelling the field gives, so an untouched one is no change', () => {
    const withExpiry = row({ expiresAt: '2026-11-01T10:00:00.000Z' });
    expect(editDiff(withExpiry, editStart(withExpiry))).toEqual({});
  });
  it('allows an edit only on an active or stopped price alert', () => {
    expect(canEdit(row())).toBe(true);
    expect(canEdit(row({ status: 'stopped' }))).toBe(true);
    for (const status of ['fired', 'cancelled', 'expired'] as const) expect(canEdit(row({ status }))).toBe(false);
    expect(canEdit(row({ kind: 'whale' }))).toBe(false);
  });
});

describe('finding an alert', () => {
  const label = (id: string) => (id === 'm1' ? 'BTC/USDT' : 'ETH/USDT');
  const rows = [
    row({ id: 'a', targetPrice: '9', createdAt: '2026-10-01T00:00:00.000Z', name: 'Nine' }),
    row({ id: 'b', targetPrice: '10', createdAt: '2026-10-03T00:00:00.000Z', marketId: 'm2', status: 'stopped', name: null }),
    row({ id: 'c', targetPrice: '9.5', createdAt: '2026-10-02T00:00:00.000Z', message: 'Take profit' }),
  ];
  const ids = (view: Partial<typeof DEFAULT_VIEW>) => visibleAlerts(rows, { ...DEFAULT_VIEW, ...view }, label).map((r) => r.id);
  it('sorts by time or by exact price, without turning a price into a number', () => {
    expect(ids({})).toEqual(['b', 'c', 'a']);
    expect(ids({ sort: 'oldest' })).toEqual(['a', 'c', 'b']);
    expect(ids({ sort: 'price' })).toEqual(['a', 'c', 'b']);
  });
  it('filters by status and searches name, message, market and price', () => {
    expect(ids({ status: 'stopped' })).toEqual(['b']);
    expect(ids({ search: 'profit' })).toEqual(['c']);
    expect(ids({ search: 'eth' })).toEqual(['b']);
    expect(ids({ search: '9.5' })).toEqual(['c']);
    expect(ids({ search: 'nothing here' })).toEqual([]);
  });
});

describe('pause and resume', () => {
  it('says what happened from the status that came back', () => {
    expect(activeWords({ status: 'stopped' })).toBe('paused');
    expect(activeWords({ status: 'active' })).toBe('resumed');
    expect(activeWords({ status: 'expired' })).toBe('expired');
    expect(activeWords({ status: 'fired' })).toBe('alreadyFired');
  });
  it('sends the alert and the wanted state, and believes only this person own alert', async () => {
    const fetch = vi.fn(async () => trpc({ changed: true, alert: row({ status: 'stopped' }) }));
    expect(await submitActive(client(fetch), ID, false, USER)).toMatchObject({ kind: 'done', words: 'paused' });
    expect(body(fetch)).toEqual({ id: ID, active: false });
    const foreign = vi.fn(async () => trpc({ changed: true, alert: row({ userId: 'someone-else', status: 'stopped' }) }));
    expect((await submitActive(client(foreign), ID, false, USER)).kind).toBe('unknown');
  });
});

describe('edit and delete', () => {
  it('sends the id and the changed fields, and does not believe an answer that is not what was sent', async () => {
    const fetch = vi.fn(async () => trpc({ alert: row({ targetPrice: '70000' }) }));
    expect(await submitEdit(client(fetch), ID, { targetPrice: '70000.0' }, USER)).toMatchObject({ kind: 'edited' });
    expect(url(fetch)).toBe('/api/notify/trpc/notify.updateAlert');
    expect(body(fetch)).toEqual({ id: ID, targetPrice: '70000.0' });
    const stale = vi.fn(async () => trpc({ alert: row() }));
    expect((await submitEdit(client(stale), ID, { targetPrice: '70000' }, USER)).kind).toBe('unknown');
    const cleared = vi.fn(async () => trpc({ alert: row({ name: null }) }));
    expect((await submitEdit(client(cleared), ID, { name: null }, USER)).kind).toBe('edited');
  });
  it('maps the refusals of a change', async () => {
    const edit = (response: Response) =>
      submitEdit(
        client(async () => response),
        ID,
        { name: 'x' },
        USER,
      );
    expect(await edit(trpcError(412, 'alert.not_editable: the alert is fired', 'PRECONDITION_FAILED'))).toEqual({
      kind: 'refused',
      refusal: 'notEditable',
    });
    expect(await edit(trpcError(404, 'alert.not_found', 'NOT_FOUND'))).toEqual({ kind: 'refused', refusal: 'notFound' });
    expect(await edit(trpcError(400, 'alert.text_too_long: too long', 'BAD_REQUEST'))).toEqual({
      kind: 'refused',
      refusal: 'textRejected',
    });
    expect(await edit(trpcError(412, 'notify.alert_text_limit_unset', 'PRECONDITION_FAILED'))).toEqual({
      kind: 'refused',
      refusal: 'optionNotOn',
    });
  });
  it('treats a dropped connection as unknown, never failed or done', async () => {
    const down = async () => {
      throw new TypeError('network down');
    };
    expect((await submitEdit(client(down), ID, { name: 'x' }, USER)).kind).toBe('unknown');
    expect((await submitDelete(client(down), ID)).kind).toBe('unknown');
  });
  it('deletes once and reports an alert that was already gone', async () => {
    const fetch = vi.fn(async () => trpc({ deleted: false }));
    expect(await submitDelete(client(fetch), ID)).toEqual({ kind: 'deleted', deleted: false });
    expect(url(fetch)).toBe('/api/notify/trpc/notify.deleteAlert');
    expect(body(fetch)).toEqual({ id: ID });
  });
});

describe('trigger history', () => {
  const trigger = {
    alertId: ID,
    marketId: 'm1',
    condition: 'greater_than',
    targetPrice: '100',
    markPrice: '101.5',
    firedAt: '2026-10-20T12:00:00.000Z',
    notificationId: null,
  };
  it('always sends a page size, reads prices as text, and gives the retention', async () => {
    const fetch = vi.fn(async () => trpc({ retentionDays: 30, items: [trigger] }));
    const result = await listAlertTriggers(client(fetch), { limit: 50 });
    expect(result.ok && result.data.items[0]!.markPrice).toBe('101.5');
    expect(decodeURIComponent((fetch.mock.calls[0] as unknown as [string])[0])).toContain('"limit":50');
  });
  it('says the history is not switched on when the platform has not set how long it is kept', async () => {
    const result = await listAlertTriggers(
      client(async () => trpcError(412, 'notify.alert_trigger_log_retention_unset: not set', 'PRECONDITION_FAILED')),
      { limit: 50 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(settleFailure(result)).toEqual({ kind: 'refused', refusal: 'logOff' });
  });
  it('refuses an answer in an unknown shape instead of showing it', async () => {
    const result = await listAlertTriggers(
      client(async () => trpc({ retentionDays: 30, items: [{ ...trigger, markPrice: 101.5 }] })),
      {
        limit: 50,
      },
    );
    expect(result.ok).toBe(false);
  });
});

function url(fetch: ReturnType<typeof vi.fn>): string {
  return (fetch.mock.calls[0] as unknown as [string])[0];
}
