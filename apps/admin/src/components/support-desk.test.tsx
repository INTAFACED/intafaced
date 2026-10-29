import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SupportDeskView, type DeskViewProps } from './support-desk';
import type { SupportQueueView, SupportTicketView } from '@/lib/support/types';

const ME = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const entry = (over: Record<string, unknown> = {}) => ({
  ticketId: T1,
  userId: U,
  category: 'account',
  status: 'open' as const,
  subject: 'Cannot sign in <script>x</script>',
  score: 10,
  ageMs: 3 * 3_600_000,
  createdAt: '2026-10-17T00:00:00.000Z',
  ...over,
});
const queue = (entries = [entry()], limit = 100): SupportQueueView => ({
  asOf: '2026-10-17T03:00:00.000Z',
  queue: { kind: 'ok', data: { entries, limit } },
});
const ticket = (over: Record<string, unknown> = {}) => ({
  id: T1,
  userId: U,
  category: 'account' as const,
  subject: 'Cannot sign in',
  body: 'I lost my authenticator\n<b>please</b>',
  status: 'open' as const,
  assigneeId: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  ...over,
});
const detail = (t = ticket()): SupportTicketView => ({
  asOf: '2026-10-17T03:01:00.000Z',
  detail: {
    kind: 'ok',
    data: {
      ticket: t,
      comments: {
        kind: 'ok',
        data: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            ticketId: T1,
            authorId: U,
            authorRole: 'user',
            body: 'any update?',
            createdAt: '2026-10-17T01:00:00.000Z',
          },
        ],
      },
      events: {
        kind: 'ok',
        data: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            ticketId: T1,
            sequence: 1,
            kind: 'opened',
            actorId: U,
            actorRole: 'user',
            fromStatus: null,
            toStatus: null,
            note: null,
            occurredAt: '2026-10-17T00:00:00.000Z',
          },
        ],
      },
      propertyChanges: {
        kind: 'ok',
        data: [
          {
            logId: '7',
            ticketId: T1,
            setBy: ME,
            reason: 'deadline',
            setAt: '2026-10-17T02:00:00.000Z',
            field: 'labels',
            from: [],
            to: ['vip', 'chargeback'],
          },
        ],
      },
    },
  },
});
const base: DeskViewProps = {
  queue: queue(),
  ticket: null,
  ticketId: null,
  userId: ME,
  loadingQueue: false,
  loadingTicket: false,
  arming: false,
  busy: false,
  reply: null,
  extras: null,
  loadingExtras: false,
  onActionDone: () => undefined,
  onRefresh: () => undefined,
  onOpen: () => undefined,
  onClose: () => undefined,
  onArm: () => undefined,
  onClaim: () => undefined,
};
const render = (over: Partial<DeskViewProps> = {}) => renderToStaticMarkup(<SupportDeskView {...base} {...over} />);

describe('the queue', () => {
  it('offers a tick box on every row and the bulk bar only when the page wires one', () => {
    expect(render()).not.toContain('Tick every request shown');
    const html = render({
      bulk: { selected: new Set([T1]), onToggle: () => undefined, onToggleAll: () => undefined, bar: <p data-testid="bar-here">bar</p> },
    });
    expect(html).toContain('Tick every request shown');
    expect(html).toMatch(/aria-label="Tick Cannot sign in[^"]*"[^>]*checked=""|checked=""[^>]*aria-label="Tick Cannot sign in/);
    expect(html).toContain('data-testid="bar-here"');
  });

  it('lists tickets with their wait, escaped, and says when it was read', () => {
    const html = render();
    expect(html).toContain('Cannot sign in &lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('3 h 0 min');
    expect(html).toContain('As of 03:00:00 UTC');
  });
  it('metrics are of the page given, and say the score is not a promise', () => {
    const html = render();
    expect(html).toContain('1 shown');
    expect(html).toContain('not a response-time promise');
    expect(html).not.toContain('there may be more');
  });
  it('a full page is flagged as not totals', () => {
    expect(render({ queue: queue([entry()], 1) })).toContain('there may be more');
  });
  it('an empty queue is reported only because the service said empty', () => {
    expect(render({ queue: queue([]) })).toContain('svc-support says the queue is empty');
  });
  it('a founder without the support-staff permission sees why and no queue', () => {
    const html = render({
      queue: {
        asOf: 'x',
        queue: {
          kind: 'failed',
          message: 'svc-support did not accept your founder session (support:ops).',
          code: null,
          notBuilt: false,
          forbidden: true,
        },
      },
    });
    expect(html).toContain('Support queue unavailable');
    expect(html).toContain('support:ops');
    expect(html).not.toContain('queue-empty');
    expect(html).not.toContain('Support queue"');
  });
  it('no read says so', () => {
    expect(render({ queue: null })).toContain('Nothing is shown rather than a guess');
  });
});

describe('a ticket', () => {
  const open = (over: Partial<DeskViewProps> = {}) => render({ ticketId: T1, ticket: detail(), ...over });
  it('shows the customer’s words as text, the conversation and the history', () => {
    const html = open();
    expect(html).toContain('I lost my authenticator');
    expect(html).toContain('&lt;b&gt;please&lt;/b&gt;');
    expect(html).toContain('any update?');
    expect(html).toContain('opened');
    expect(html).toContain('Nobody yet');
  });
  it('the history shows each priority, type or label change as its own row, after the trail event before it', () => {
    const html = open();
    expect(html).toContain('labels none → vip, chargeback');
    expect(html).toContain('deadline');
    expect(html.indexOf('opened')).toBeLessThan(html.indexOf('labels none → vip, chargeback'));
  });
  it('labels the customer as an account id and says why no handle is shown', () => {
    const html = open();
    expect(html).toContain('<dt>Customer account id</dt>');
    expect(html).toContain('No handle: svc-identity has no operator read that names an account from its id (back-end need 47).');
  });
  it('an unowned ticket can be claimed, after a second click that says there is no release', () => {
    expect(open()).toContain('Claim this ticket');
    const armed = open({ arming: true });
    expect(armed).toContain('svc-support has no release or reassign');
    expect(armed).toContain('Yes, claim it');
  });
  it('a ticket someone else owns cannot be claimed, and says why', () => {
    const html = open({ ticket: detail(ticket({ assigneeId: U })) });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Claim this ticket<\/button>/);
    expect(html).toContain('does not allow taking it over');
  });
  it('my own ticket says "You"', () => {
    const html = open({ ticket: detail(ticket({ assigneeId: ME })) });
    expect(html).toContain('<dd>You</dd>');
    expect(html).toContain('You already own this ticket');
  });
  it('a ticket that failed to load says so and shows no body', () => {
    const html = open({
      ticket: {
        asOf: 'x',
        detail: { kind: 'failed', message: 'svc-support did not answer.', code: null, notBuilt: false, forbidden: false },
      },
    });
    expect(html).toContain('Ticket unavailable');
    expect(html).not.toContain('What the customer wrote');
  });
  it('comments failing do not hide the ticket', () => {
    const d = detail();
    if (d.detail.kind !== 'ok') throw new Error('fixture');
    const html = open({
      ticket: {
        ...d,
        detail: {
          kind: 'ok',
          data: { ...d.detail.data, comments: { kind: 'failed', message: 'down', code: null, notBuilt: false, forbidden: false } },
        },
      },
    });
    expect(html).toContain('Comments unavailable');
    expect(html).toContain('What the customer wrote');
  });
  it('the claim answer is the service’s, and a refusal says nothing changed', () => {
    const ok = open({ reply: { ok: true, ticketId: T1, assigneeId: ME, status: 'open' } });
    expect(ok).toContain('svc-support says the ticket is now owned by');
    const no = open({
      reply: {
        ok: false,
        refusal: { title: 'The state moved on', body: 'This ticket is already claimed', next: 'n', code: null, changed: 'no' },
      },
    });
    expect(no).toContain('This ticket is already claimed');
  });
});
