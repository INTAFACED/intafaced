import { describe, expect, it } from 'vitest';
import {
  RATING_SCORES,
  canFollowUp,
  canReply,
  followUpDraft,
  filterTickets,
  inKbCategory,
  kbCategory,
  kbCategoryCounts,
  matchesFilter,
  newestFirst,
  replyReopens,
  requestActionStates,
  showRatePrompt,
  statusCounts,
  supportEmail,
  supportRequestHref,
  requestFromSearch,
  supportFollowUpHref,
  supportRoute,
  supportNewHref,
  customerStatus,
  supportMailto,
  ticketReference,
  type TicketLike,
} from './support-desk';

const row = (over: Partial<TicketLike> & { id: string }): TicketLike => ({
  subject: 'Subject',
  body: 'Body',
  category: 'other',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('status filters', () => {
  it('treats open and in-progress as active, and keeps resolved and closed apart', () => {
    expect(matchesFilter('open', 'active')).toBe(true);
    expect(matchesFilter('pending', 'active')).toBe(true);
    expect(matchesFilter('on_hold', 'active')).toBe(true);
    expect(matchesFilter('on_hold', 'resolved')).toBe(false);
    expect(matchesFilter('resolved', 'active')).toBe(false);
    expect(matchesFilter('closed', 'active')).toBe(false);
    expect(matchesFilter('closed', 'all')).toBe(true);
    expect(matchesFilter('resolved', 'resolved')).toBe(true);
  });

  it('counts every request in exactly one bucket', () => {
    const rows = [
      row({ id: 'a', status: 'open' }),
      row({ id: 'b', status: 'pending' }),
      row({ id: 'c', status: 'resolved' }),
      row({ id: 'd', status: 'closed' }),
      row({ id: 'e', status: 'on_hold' }),
    ];
    expect(statusCounts(rows)).toEqual({ all: 5, active: 3, resolved: 1, closed: 1 });
  });
});

describe('ordering and search', () => {
  it('puts the newest activity first and sinks an unreadable time', () => {
    const sorted = newestFirst([
      row({ id: 'old', updatedAt: '2026-10-01T00:00:00.000Z' }),
      row({ id: 'bad', updatedAt: 'nope' }),
      row({ id: 'new', updatedAt: '2026-10-09T00:00:00.000Z' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['new', 'old', 'bad']);
  });

  it('searches subject, message and reference, ignoring case and accents', () => {
    const rows = [
      row({ id: '11111111-aaaa-bbbb-cccc-000000000001', subject: 'Retrait bloqué', body: 'cannot withdraw' }),
      row({ id: '22222222-aaaa-bbbb-cccc-000000000002', subject: 'Other', body: 'Login loop' }),
    ];
    expect(filterTickets(rows, 'all', 'RETRAIT').map((r) => r.subject)).toEqual(['Retrait bloqué']);
    expect(filterTickets(rows, 'all', 'retrait bloque')).toHaveLength(1);
    expect(filterTickets(rows, 'all', 'login')).toHaveLength(1);
    expect(filterTickets(rows, 'all', '#22222222')).toHaveLength(1);
    expect(filterTickets(rows, 'closed', '')).toHaveLength(0);
  });

  it('gives a short quotable reference without changing the id', () => {
    expect(ticketReference('a1b2c3d4-0000-0000-0000-000000000000')).toBe('#A1B2C3D4');
  });
});

describe('what a person can do to a request', () => {
  it('takes replies until the request is closed, and says a reply reopens a resolved one', () => {
    expect(canReply('open')).toBe(true);
    expect(canReply('resolved')).toBe(true);
    expect(canReply('closed')).toBe(false);
    expect(replyReopens('resolved')).toBe(true);
    expect(replyReopens('open')).toBe(false);
  });

  it('offers close, rate and attach from the status, with a named reason when one is off', () => {
    expect(requestActionStates('open', false)).toEqual({
      close: { available: true },
      rate: { available: false, reason: 'rateNotYet' },
      attach: { available: true },
    });
    expect(requestActionStates('pending', false).rate).toEqual({ available: false, reason: 'rateNotYet' });
    expect(requestActionStates('resolved', false)).toEqual({
      close: { available: true },
      rate: { available: true },
      attach: { available: true },
    });
    expect(requestActionStates('closed', false)).toEqual({
      close: { available: false, reason: 'closeAlreadyClosed' },
      rate: { available: true },
      attach: { available: false, reason: 'attachClosed' },
    });
  });

  it('rates a request once', () => {
    expect(requestActionStates('resolved', true).rate).toEqual({ available: false, reason: 'rateDone' });
    expect(requestActionStates('closed', true).rate).toEqual({ available: false, reason: 'rateDone' });
  });

  it('accepts the whole scores 1 to 5, best first', () => {
    expect([...RATING_SCORES]).toEqual([5, 4, 3, 2, 1]);
  });
});

describe('help article groups', () => {
  it('groups the published articles and falls back to general', () => {
    expect(kbCategory('kb-account-access')).toBe('account');
    expect(kbCategory('kb-security-basics')).toBe('security');
    expect(kbCategory('kb-orders-status')).toBe('trading');
    expect(kbCategory('kb-deposit-withdraw-honest')).toBe('money');
    expect(kbCategory('kb-new-passkey-guide')).toBe('security');
    expect(kbCategory('kb-something-unseen')).toBe('general');
  });

  it('counts only groups that hold articles, and "all" always holds every one', () => {
    const counts = kbCategoryCounts(['kb-account-access', 'kb-security-basics', 'kb-orders-status', 'kb-paper-vs-live']);
    expect(counts).toEqual({ all: 4, account: 1, security: 1, trading: 2 });
    expect(inKbCategory('kb-orders-status', 'all')).toBe(true);
    expect(inKbCategory('kb-orders-status', 'trading')).toBe(true);
    expect(inKbCategory('kb-orders-status', 'money')).toBe(false);
  });
});

describe('contact address', () => {
  it('uses a configured address only when it is a plain address, else it is not set', () => {
    expect(supportEmail('help@example.org')).toBe('help@example.org');
    expect(supportEmail('  help@example.org ')).toBe('help@example.org');
    expect(supportEmail('not an address')).toBeNull();
    expect(supportEmail(undefined)).toBeNull();
    expect(supportEmail('   ')).toBeNull();
  });

  it('builds a mailto that carries only the text it was given, encoded', () => {
    const href = supportMailto('a@b.co', "Can't sign in", 'Hi & thanks');
    expect(href).toBe("mailto:a@b.co?subject=Can't%20sign%20in&body=Hi%20%26%20thanks");
  });
});

describe('follow-up on a closed request', () => {
  it('is offered on a closed request only', () => {
    expect(canFollowUp('closed')).toBe(true);
    for (const status of ['open', 'pending', 'resolved'] as const) expect(canFollowUp(status)).toBe(false);
  });

  it('starts from the same topic with a subject that names what it follows, within the subject limit', () => {
    expect(followUpDraft({ category: 'trading', subject: 'Order stuck' }, 'Follow-up:')).toEqual({
      category: 'trading',
      subject: 'Follow-up: Order stuck',
    });
    expect(followUpDraft({ category: 'other', subject: 'x'.repeat(200) }, 'Follow-up:').subject).toHaveLength(200);
  });
});

describe('the rate-this-request prompt', () => {
  it('shows on a solved request that has been read and is not yet rated', () => {
    expect(showRatePrompt('resolved', true, false)).toBe(true);
    expect(showRatePrompt('closed', true, false)).toBe(true);
  });

  it('stays away while the rating is unread, once rated, and before the request is solved', () => {
    expect(showRatePrompt('resolved', false, false)).toBe(false);
    expect(showRatePrompt('resolved', true, true)).toBe(false);
    for (const status of ['open', 'pending', 'on_hold'] as const) expect(showRatePrompt(status, true, false)).toBe(false);
  });
});

describe('opening one request from an address', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  it('builds the address from a request id and reads it back', () => {
    expect(supportRequestHref(ID)).toBe(`/support/tickets/${ID}`);
    expect(supportRoute(`/support/tickets/${ID}`, '')).toEqual({ view: 'request', id: ID });
    expect(supportRoute(`/support/tickets/${ID.toUpperCase()}/`, '')).toEqual({ view: 'request', id: ID });
    // The address from before requests had their own still opens the request.
    expect(supportRoute('/support', `?request=${ID}`)).toEqual({ view: 'request', id: ID });
    expect(requestFromSearch(`?request=${ID}`)).toBe(ID);
    expect(requestFromSearch(`?request=${ID.toUpperCase()}`)).toBe(ID);
  });
  it('carries the request a follow-up follows in the address, and drops an id that is not one', () => {
    expect(supportFollowUpHref(ID)).toBe(`/support/new?follows=${ID}`);
    expect(supportRoute('/support/new', `?follows=${ID.toUpperCase()}`)).toEqual({ view: 'new', subject: '', follows: ID });
    expect(supportRoute('/support/new', `?follows=${ID}&subject=more`)).toEqual({ view: 'new', subject: 'more', follows: ID });
    for (const bad of ['?follows=abc', `?follows=${ID}x`, '?follows='])
      expect(supportRoute('/support/new', bad)).toEqual({ view: 'new', subject: '' });
  });
  it('names each part of the desk by its address', () => {
    expect(supportRoute('/support', '')).toEqual({ view: 'help' });
    expect(supportRoute('/support', '?q=passkey')).toEqual({ view: 'help' });
    expect(supportRoute('/support/tickets', '')).toEqual({ view: 'requests' });
    expect(supportRoute('/support/new', '')).toEqual({ view: 'new', subject: '' });
    expect(supportRoute('/support/new', '?subject=%20lost%20phone%20')).toEqual({ view: 'new', subject: 'lost phone' });
    expect(supportRoute('/support/new', `?subject=${'x'.repeat(300)}`)).toEqual({ view: 'new', subject: 'x'.repeat(200) });
    for (const bad of ['/support/tickets/abc', '/support/tickets/%E0%A4%A', `/support/tickets/${ID}x`])
      expect(supportRoute(bad, '')).toEqual({ view: 'badRequest' });
    for (const other of ['/support/ticket', '/support/foo', `/support/tickets/${ID}/comments`])
      expect(supportRoute(other, '')).toEqual({ view: 'unknown' });
  });
  it('drafts the form address from search words, and the form with none', () => {
    expect(supportNewHref('  lost phone ')).toBe('/support/new?subject=lost+phone');
    expect(supportNewHref('   ')).toBe('/support/new');
    expect(supportNewHref('y'.repeat(300))).toBe(`/support/new?subject=${'y'.repeat(200)}`);
  });
  it('reads the customer status, and a finished request is solved whatever an older service says', () => {
    expect(customerStatus({ status: 'pending', customerStatus: 'awaiting_reply' })).toBe('awaiting_reply');
    expect(customerStatus({ status: 'open' })).toBe('open');
    expect(customerStatus({ status: 'resolved' })).toBe('solved');
    expect(customerStatus({ status: 'closed', customerStatus: 'open' })).toBe('solved');
  });
  it('anything that is not a request id opens nothing', () => {
    for (const search of ['', '?request=', '?request=abc', `?request=${ID}x`, '?request=../../x', `?other=${ID}`])
      expect(requestFromSearch(search)).toBeNull();
  });
});
