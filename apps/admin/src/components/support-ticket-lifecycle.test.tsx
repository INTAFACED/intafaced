import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportLifecycleView } from '@/lib/support/types';
import { TicketLifecycleView } from './support-ticket-lifecycle';

const T1 = '22222222-2222-4222-8222-222222222222';
const T0 = '33333333-3333-4333-8333-333333333333';
const life = (over: Record<string, unknown> = {}) => ({
  ticketId: T1,
  waitingOn: null,
  waitingSince: null,
  firstPublicReplyAt: null,
  followsTicketId: null,
  ...over,
});
const view = (over: Record<string, unknown> = {}): SupportLifecycleView => ({
  asOf: '2026-10-20T04:00:00.000Z',
  lifecycle: { kind: 'ok', data: life(over) } as SupportLifecycleView['lifecycle'],
});
const html = (v: SupportLifecycleView | null, status = 'open', loading = false) =>
  renderToStaticMarkup(<TicketLifecycleView ticket={{ id: T1, status: status as 'open' }} view={v} loading={loading} />);

describe('waiting-on panel (SP-tickets-04)', () => {
  it('nothing set reads "Nobody yet", never a guessed side', () => {
    const out = html(view());
    expect(out).toContain('Nobody yet');
    expect(out).toContain('None yet');
  });

  it('names the side, the time and the request it follows', () => {
    const out = html(
      view({
        waitingOn: 'customer',
        waitingSince: '2026-10-20T03:00:00.000Z',
        firstPublicReplyAt: '2026-10-20T02:00:00.000Z',
        followsTicketId: T0,
      }),
    );
    expect(out).toContain('The customer');
    expect(out).toContain('20 Oct 2026, 03:00:00 UTC');
    expect(out).toContain('20 Oct 2026, 02:00:00 UTC');
    expect(out).toContain(T0);
  });

  it('says a held request is held by the team', () => {
    expect(html(view({ waitingOn: 'customer', waitingSince: '2026-10-20T03:00:00.000Z' }), 'on_hold')).toContain('On hold by the team');
  });

  it('shows reading, and a plain line when svc-support could not be read', () => {
    expect(html(null, 'open', true)).toContain('Reading');
    expect(html(null)).toContain('could not be read');
  });

  it('shows a refusal as unavailable, not as empty', () => {
    const failed = {
      asOf: 'x',
      lifecycle: { kind: 'failed', message: 'No', code: 'support.not_staff', forbidden: false },
    } as unknown as SupportLifecycleView;
    expect(html(failed)).toContain('Waiting on unavailable');
  });
});
