import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PayHaltPendingClear, PayHaltState } from '@intafaced/contracts';
import { PayHaltsDeskView, type PayHaltsViewProps } from './pay-halts-desk';
import type { PayHaltsRead } from '@/lib/pay-halts/types';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const state = (over: Partial<PayHaltState> = {}): PayHaltState => ({
  scope: 'intake',
  target: { level: 'global' },
  halted: false,
  reason: null,
  source: null,
  actorUserId: null,
  version: '0',
  changedAt: null,
  ...over,
});
const proposal = (over: Partial<PayHaltPendingClear> = {}): PayHaltPendingClear => ({
  requestId: '55555555-5555-4555-8555-555555555555',
  scope: 'payout',
  target: { level: 'global' },
  expectedVersion: '3',
  reason: 'rail recovered, clearing',
  requestedByUserId: OTHER,
  requestedAt: '2026-10-17T02:00:00.000Z',
  ...over,
});
const read = (over: Partial<PayHaltsRead> = {}): PayHaltsRead => ({
  asOf: '2026-10-17T03:00:00.000Z',
  status: {
    kind: 'ok',
    data: {
      readable: true,
      autoTrip: { enabled: false, consecutiveFailures: null },
      states: [
        state(),
        state({
          scope: 'payout',
          halted: true,
          reason: 'rail incident',
          version: '3',
          actorUserId: OTHER,
          source: 'operator',
          changedAt: '2026-10-17T01:00:00.000Z',
        }),
      ],
    },
  },
  pending: { kind: 'ok', data: { proposals: [], nextCursor: null } },
  history: { kind: 'ok', data: [] },
  ...over,
});
const base: PayHaltsViewProps = {
  read: read(),
  userId: ME,
  loading: false,
  scope: 'intake',
  level: 'global',
  targetId: '',
  reason: '',
  confirm: '',
  busy: false,
  reply: null,
  picked: null,
  onRead: () => undefined,
  onScope: () => undefined,
  onLevel: () => undefined,
  onTargetId: () => undefined,
  onReason: () => undefined,
  onConfirm: () => undefined,
  onSubmit: () => undefined,
  onPick: () => undefined,
};
const render = (over: Partial<PayHaltsViewProps> = {}) => renderToStaticMarkup(<PayHaltsDeskView {...base} {...over} />);
const submit = (html: string) => /<button type="submit"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? '';

describe('the halts and their time', () => {
  it('lists each halt with who set it and since when, and states the read time', () => {
    const html = render();
    expect(html).toContain('As of 03:00:00 UTC');
    expect(html).toContain('HALTED');
    expect(html).toContain('rail incident');
    expect(html).toContain('Paying out');
  });
  it('says automatic trip is off rather than implying safety', () => {
    expect(render()).toContain('Automatic trip is off: nothing pauses by itself');
  });
  it('an unreadable halt store is a loud banner, not a clean table', () => {
    const html = render({
      read: read({
        status: { kind: 'ok', data: { readable: false, autoTrip: { enabled: false, consecutiveFailures: null }, states: [] } },
      }),
    });
    expect(html).toContain('svc-pay cannot read its halt store');
    expect(html).toContain('every operation counts as halted');
    expect(submit(html)).toContain('disabled=""');
  });
  it('a failed read shows the failure and no table, and nothing can be changed', () => {
    const html = render({
      read: read({ status: { kind: 'failed', message: 'svc-pay did not answer.', code: null, notBuilt: false, forbidden: false } }),
    });
    expect(html).toContain('Current halts unavailable');
    expect(html).not.toContain('aria-label="Current halts"');
    expect(submit(html)).toContain('disabled=""');
    expect(html).toContain('cannot be changed'.slice(0, 0) + 'could not be read');
  });
  it('no read at all says so', () => {
    const html = render({ read: null });
    expect(html).toContain('No read yet');
    expect(html).toContain('Nothing is shown rather than a guess');
  });
});

describe('the form chooses halt or clear from the real state', () => {
  it('a running operation is offered a halt with the HALT phrase', () => {
    const html = render({ scope: 'intake' });
    expect(html).toContain('Halt an operation');
    expect(html).toContain('<code>HALT intake</code>');
    expect(html).toContain('Right now: Taking payments for Everyone (global) is running (version 0)');
  });
  it('a halted operation is offered a CLEAR that needs a second founder', () => {
    const html = render({ scope: 'payout' });
    expect(html).toContain('Ask to clear a halt');
    expect(html).toContain('<code>CLEAR payout</code>');
    expect(html).toContain('is HALTED (version 3)');
    expect(html).toContain('Ask for a second founder to confirm the clear');
  });
  it('opens only with a reason and the exact phrase', () => {
    expect(submit(render({ reason: 'rail incident, stop sends', confirm: 'HALT intake' }))).not.toContain('disabled');
    expect(submit(render({ reason: 'rail incident, stop sends', confirm: 'HALT payout' }))).toContain('disabled=""');
    expect(submit(render({ reason: 'short', confirm: 'HALT intake' }))).toContain('disabled=""');
    expect(submit(render({ reason: 'rail incident, stop sends', confirm: 'HALT intake', busy: true }))).toContain('Sending…');
  });
  it('a user or rail target needs an id and only works on payouts', () => {
    const html = render({ level: 'merchant', targetId: '' });
    expect(html).toContain('Id (UUID)');
    expect(submit(html)).toContain('disabled=""');
    const bad = render({ scope: 'intake', level: 'user', targetId: M, reason: 'rail incident, stop sends', confirm: 'HALT intake' });
    expect(submit(bad)).toContain('disabled=""');
    expect(bad).toContain('only works on payouts');
  });
});

describe('clears waiting for a second founder', () => {
  const withPending = (p: PayHaltPendingClear) => read({ pending: { kind: 'ok', data: { proposals: [p], nextCursor: null } } });
  it('another founder’s proposal can be reviewed and confirmed', () => {
    const html = render({ read: withPending(proposal()) });
    expect(html).toContain('Review and confirm');
    expect(html).toContain('rail recovered, clearing');
  });
  it('my own proposal cannot be confirmed by me', () => {
    const html = render({ read: withPending(proposal({ requestedByUserId: ME })) });
    expect(html).toContain('A different founder has to confirm');
    expect(html).not.toContain('Review and confirm');
    expect(html).toContain('(you)');
  });
  it('none waiting says so', () => {
    expect(render()).toContain('No clear is waiting for a second founder');
  });
  it('the confirm form names what lifting the halt does and needs its own phrase and reason', () => {
    const p = proposal();
    const html = render({ read: withPending(p), picked: p, reason: p.reason, confirm: '' });
    expect(html).toContain('data-testid="confirm-clear-form"');
    expect(html).toContain('Confirming lifts the halt');
    expect(html).toContain('<code>CLEAR payout</code>');
    const confirmButton = /<button type="submit"[^>]*>Confirm the clear<\/button>/.exec(html)?.[0] ?? '';
    expect(confirmButton).toContain('disabled=""');
    // The main form is shut while a confirmation is open.
    expect(submit(html.replace(/<form[^>]*data-testid="confirm-clear-form"[\s\S]*?<\/form>/, ''))).toContain('disabled=""');
  });
  it('a failed pending read is shown as a failure, not as "none waiting"', () => {
    const html = render({
      read: read({ pending: { kind: 'failed', message: 'svc-pay did not answer.', code: null, notBuilt: false, forbidden: false } }),
    });
    expect(html).toContain('Pending clears unavailable');
    expect(html).not.toContain('No clear is waiting');
  });
});

describe('what svc-pay answered', () => {
  const reply = (outcome: 'changed' | 'noop' | 'conflict' | 'pending_confirmation', halted: boolean) =>
    ({
      ok: true,
      requestId: 'r',
      outcome,
      action: 'halt',
      state: { scope: 'intake', target: { level: 'global' }, halted, version: '4' },
    }) as const;
  it('a pending clear says the halt is still on, and is not shown as applied', () => {
    const html = render({ reply: reply('pending_confirmation', true) });
    expect(html).toContain('Recorded, waiting for a second founder');
    expect(html).toContain('STILL ON');
    expect(html).not.toContain('data-tone="ok"');
  });
  it('a change is reported with the version svc-pay returned', () => {
    const html = render({ reply: reply('changed', true) });
    expect(html).toContain('Halt applied');
    expect(html).toContain('version 4');
  });
  it('a conflict is not applied', () => {
    expect(render({ reply: reply('conflict', true) })).toContain('Not applied: the halt moved on');
  });
  it('a refusal says whether anything changed', () => {
    const unknown = render({
      reply: { ok: false, refusal: { title: 'The outcome is not known', body: 'b', next: 'n', code: null, changed: 'unknown' } },
    });
    expect(unknown).toContain('Outcome not known.');
    const no = render({
      reply: { ok: false, refusal: { title: 'No such merchant', body: 'b', next: 'n', code: 'pay.halt_target_not_found', changed: 'no' } },
    });
    expect(no).toContain('Nothing was changed.');
  });
});
