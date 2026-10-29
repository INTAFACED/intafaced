import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionReply } from '@/lib/support/browser';
import type { SupportKbView, TicketExtrasView } from '@/lib/support/types';
import {
  TicketActionsView,
  buildRequest,
  citedIds,
  effectiveStatus,
  emptyForm,
  type ActionForm,
  type TicketActionsViewProps,
} from './support-ticket-actions';
import { TicketExtras } from './support-ticket-extras';
import { KbPanelView, emptyKbForm, kbEnglishText, kbPublishRequest, kbPublishWhy, type KbPanelViewProps } from './support-kb-panel';

const T1 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const FORBIDDEN: ActionReply = {
  ok: false,
  refusal: {
    title: 'Your console session does not have support operations permission',
    body: 'b',
    next: 'Nothing was changed.',
    code: 'scope.denied',
    changed: 'no',
  },
};
const open = { id: T1, status: 'open' as const };
const base = (over: Partial<TicketActionsViewProps> = {}): TicketActionsViewProps => ({
  ticket: open,
  form: emptyForm(open),
  armed: null,
  busy: false,
  outcome: null,
  onField: () => undefined,
  onArm: () => undefined,
  onSend: () => undefined,
  ...over,
});
const html = (over: Partial<TicketActionsViewProps> = {}) => renderToStaticMarkup(<TicketActionsView {...base(over)} />);
const form = (over: Partial<ActionForm> = {}): ActionForm => ({ ...emptyForm(open), ...over });
const buttonTag = (markup: string, label: string) => {
  const found = new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0];
  if (!found) throw new Error(`No "${label}" button`);
  return found;
};

describe('ticket actions render for every founder', () => {
  it('shows reply, status and escalate controls on a fresh open ticket, each off only for a reason the page states', () => {
    const markup = html();
    expect(markup).toContain('Reply to the customer');
    expect(markup).toContain('Set the status');
    expect(markup).toContain('Escalate with a case file');
    expect(buttonTag(markup, 'Review reply')).toContain('disabled');
    expect(markup).toContain('Write the reply first.');
    expect(buttonTag(markup, 'Review escalation')).toContain('disabled');
    expect(markup).toContain('Write what you concluded first.');
    expect(buttonTag(markup, 'Review status change')).not.toContain('disabled');
  });

  it('turns the buttons on once there are words', () => {
    const markup = html({ form: form({ replyBody: 'Hello', escSummary: 'Needs review' }) });
    expect(buttonTag(markup, 'Review reply')).not.toContain('disabled');
    expect(buttonTag(markup, 'Review escalation')).not.toContain('disabled');
  });

  it('never hides a control because of permission: nothing on the page mentions support:ops until the service answers', () => {
    expect(html()).not.toContain('support:ops');
    expect(html()).not.toContain('operations permission');
  });

  it('on a closed ticket the status select offers nothing and every button says why it is off', () => {
    const closed = { id: T1, status: 'closed' as const };
    const markup = html({ ticket: closed, form: form({ replyBody: 'x', escSummary: 'y' }) });
    expect(markup).toContain('None: closed is final');
    expect(buttonTag(markup, 'Review status change')).toContain('disabled');
    expect(markup).toContain('A closed ticket stays closed');
    expect(buttonTag(markup, 'Review reply')).toContain('disabled');
    expect(markup).toContain('takes no replies on a closed ticket');
    expect(buttonTag(markup, 'Review escalation')).toContain('disabled');
  });

  it('offers only the moves svc-support allows from the current status', () => {
    const markup = html({ ticket: { id: T1, status: 'resolved' } });
    const options = [...markup.matchAll(/<option value="([a-z_]+)"[^>]*>(?:open|pending|resolved|closed)<\/option>/g)].map((m) => m[1]);
    expect(options).toEqual(['open', 'closed']);
  });
});

describe('the second click', () => {
  it('a reply says it cannot be unsent and sends nothing until "yes"', () => {
    const markup = html({ form: form({ replyBody: 'Hello' }), armed: 'reply' });
    expect(markup).toContain('A reply cannot be unsent.');
    expect(markup).toContain('Yes, send the reply');
  });
  it('closing says closed is final', () => {
    const markup = html({ form: form({ statusNext: 'closed' }), armed: 'status' });
    expect(markup).toContain('Move this ticket to closed?');
    expect(markup).toContain('Closed is final.');
  });
  it('an escalation says the case file cannot be edited, and that nothing moves money', () => {
    const markup = html({ form: form({ escSummary: 's' }), armed: 'escalate' });
    expect(markup).toContain('cannot be edited or withdrawn');
    expect(markup).toContain('Nothing here moves money');
  });
  it('the confirm button is off while a send is in progress, so a double click cannot send twice', () => {
    const markup = html({ form: form({ replyBody: 'Hello' }), armed: 'reply', busy: true });
    expect(buttonTag(markup, 'Sending…')).toContain('disabled');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Cancel<\/button>/);
  });
  it('while one step is armed the other buttons wait', () => {
    const markup = html({ form: form({ replyBody: 'Hello', escSummary: 's' }), armed: 'reply' });
    expect(buttonTag(markup, 'Review status change')).toContain('disabled');
    expect(buttonTag(markup, 'Review escalation')).toContain('disabled');
  });
});

describe('what the service answered', () => {
  it('a forbidden reply shows the support-operations message beside the control that was used, and no "Done"', () => {
    const markup = html({ outcome: { kind: 'reply', reply: FORBIDDEN } });
    expect(markup).toContain('Your console session does not have support operations permission');
    expect(markup).toContain('data-testid="reply-outcome"');
    expect(markup).not.toContain('Done');
    expect(markup).not.toContain('status-outcome');
  });
  it('a success is the service’s own sentence', () => {
    const markup = html({
      outcome: { kind: 'status', reply: { ok: true, action: 'status', summary: 'svc-support says the ticket is now resolved.' } },
    });
    expect(markup).toContain('Done');
    expect(markup).toContain('svc-support says the ticket is now resolved.');
  });
  it('"outcome not known" is shown as a warning, not a success', () => {
    const markup = html({
      outcome: {
        kind: 'reply',
        reply: { ok: false, refusal: { title: 'The outcome is not known', body: 'b', next: 'n', code: null, changed: 'unknown' } },
      },
    });
    expect(markup).toContain('The outcome is not known');
    expect(markup).toContain('data-tone="warn"');
    expect(markup).not.toContain('Done');
  });
});

describe('building the request from the form', () => {
  it('trims words and sends the reason only when written', () => {
    expect(buildRequest('reply', open, form({ replyBody: '  Hello ' }))).toEqual({ action: 'reply', ticketId: T1, body: 'Hello' });
    expect(buildRequest('status', open, form({ statusNext: 'resolved' }))).toEqual({ action: 'status', ticketId: T1, status: 'resolved' });
    expect(buildRequest('status', open, form({ statusNext: 'resolved', statusNote: ' Fixed ' }))).toMatchObject({ note: 'Fixed' });
    expect(buildRequest('escalate', open, form({ escReason: 'technical', escSummary: ' s ', escCited: 'kb-a, kb-b kb-a' }))).toEqual({
      action: 'escalate',
      ticketId: T1,
      reason: 'technical',
      summary: 's',
      citedArticleIds: ['kb-a', 'kb-b'],
    });
  });
  it('a status chosen before the ticket moved falls back to one it can still go to', () => {
    expect(effectiveStatus({ status: 'resolved' }, form({ statusNext: 'pending' }))).toBe('open');
    expect(effectiveStatus({ status: 'closed' }, form({ statusNext: 'open' }))).toBe('');
  });
  it('lists cited ids once each', () => {
    expect(citedIds('a, b\nc  a,,')).toEqual(['a', 'b', 'c']);
  });
});

describe('case file and rating', () => {
  const extras = (over: Partial<TicketExtrasView> = {}): TicketExtrasView => ({
    asOf: '2026-10-17T05:00:00.000Z',
    caseFile: { kind: 'ok', data: null },
    rating: { kind: 'ok', data: null },
    ...over,
  });
  const markup = (e: TicketExtrasView | null, loading = false) => renderToStaticMarkup(<TicketExtras extras={e} loading={loading} />);

  it('says "never escalated" and "not rated" only when the service said null', () => {
    const m = markup(extras());
    expect(m).toContain('never escalated');
    expect(m).toContain('has not rated this ticket');
  });
  it('shows a rating with its note, escaped', () => {
    const m = markup(
      extras({
        rating: { kind: 'ok', data: { ticketId: T1, userId: U, score: 2, note: '<b>slow</b>', createdAt: '2026-10-17T04:00:00.000Z' } },
      }),
    );
    expect(m).toContain('2 out of 5');
    expect(m).toContain('&lt;b&gt;slow&lt;/b&gt;');
    expect(m).not.toContain('<b>slow');
  });
  it('shows a case file with its reason, summary, grounding and citations', () => {
    const m = markup(
      extras({
        caseFile: {
          kind: 'ok',
          data: {
            ticketId: T1,
            escalatedBy: U,
            reason: 'money_request',
            citations: [{ kind: 'kb_article', ref: 'kb-a', digest: 'c'.repeat(64), readAt: '2026-10-17T03:00:00.000Z' }],
            grounding: { status: 'unread', reason: 'plane_dark' },
            summary: 'Wants a refund',
            createdAt: '2026-10-17T03:00:00.000Z',
          },
        },
      }),
    );
    expect(m).toContain('Customer asked for money to move');
    expect(m).toContain('Wants a refund');
    expect(m).toContain('identity could not be reached');
    expect(m).toContain('Help article');
    expect(m).toContain('cccccccccccc');
    expect(m).not.toContain('c'.repeat(20));
  });
  it('a forbidden part is the support-operations message, not "none"', () => {
    const forbidden = {
      kind: 'failed',
      message: 'Your console session does not have support operations permission. More.',
      code: null,
      notBuilt: false,
      forbidden: true,
    } as const;
    const m = markup(extras({ caseFile: forbidden, rating: forbidden }));
    expect(m).toContain('Case file unavailable');
    expect(m).toContain('Rating unavailable');
    expect(m).toContain('support operations permission');
    expect(m).not.toContain('never escalated');
    expect(m).not.toContain('has not rated');
  });
  it('before the read arrives it says reading, and if it never does it says so', () => {
    expect(markup(null, true)).toContain('Reading…');
    expect(markup(null, false)).toContain('Nothing is shown rather than a guess');
  });
});

describe('help articles panel', () => {
  const kb = (over: Partial<SupportKbView> = {}): SupportKbView => ({
    asOf: '2026-10-17T05:00:00.000Z',
    articles: {
      kind: 'ok',
      data: [
        {
          id: 'kb-account-access',
          titleKey: 'support.kb.account_access.title',
          bodyKey: 'support.kb.account_access.body',
          revision: 3,
          category: 'account',
        },
      ],
    },
    ...over,
  });
  const panel = (over: Partial<KbPanelViewProps> = {}) =>
    renderToStaticMarkup(
      <KbPanelView
        kb={kb()}
        loading={false}
        form={emptyKbForm}
        step={null}
        busy={false}
        outcome={null}
        onRefresh={() => undefined}
        onField={() => undefined}
        onEdit={() => undefined}
        onStep={() => undefined}
        onSend={() => undefined}
        {...over}
      />,
    );

  it('lists published articles with their revision, and offers unpublish and edit on each', () => {
    const m = panel();
    expect(m).toContain('kb-account-access');
    expect(m).toContain('<td>3</td>');
    expect(buttonTag(m, 'Unpublish')).not.toContain('disabled');
    expect(buttonTag(m, 'Edit as new version')).not.toContain('disabled');
  });
  it('shows the English title next to each key and says new article text goes in the catalogue in the code', () => {
    const m = panel();
    expect(m).toContain('Sign-in and account access');
    expect(m).toContain('support.kb.account_access.title');
    expect(m).toContain('help catalogue in the code');
    expect(m).not.toMatch(/soon|yet|will be|coming/i);
    expect(kbEnglishText('support.kb.account_access.title')).toBe('Sign-in and account access');
    expect(kbEnglishText('support.kb.nope.title')).toBeNull();
    expect(kbEnglishText('toString')).toBeNull();
    const unknown = panel({
      kb: kb({
        articles: { kind: 'ok', data: [{ id: 'kb-x', titleKey: 'support.kb.nope.title', bodyKey: 'support.kb.nope.body', revision: 1 }] },
      }),
    });
    expect(unknown).toContain('No English text in the catalogue for this key');
  });
  it('keeps the publish form on the page, off with a reason until it is filled in', () => {
    const m = panel();
    expect(buttonTag(m, 'Review publish')).toContain('disabled');
    expect(m).toContain('Give the article an id.');
    expect(m).toContain('not text');
  });
  it('turns publish on once id, keys and revision are valid', () => {
    const filled = { ...emptyKbForm, id: 'kb-a', titleKey: 'support.kb.a.title', bodyKey: 'support.kb.a.body' };
    expect(kbPublishWhy(filled, false)).toBeNull();
    expect(buttonTag(panel({ form: filled }), 'Review publish')).not.toContain('disabled');
    expect(kbPublishWhy({ ...filled, baseRevision: 'x' }, false)).toContain('whole number');
    expect(kbPublishWhy({ ...filled, baseRevision: '-1' }, false)).toContain('whole number');
    expect(kbPublishWhy(filled, true)).toContain('in progress');
  });
  it('builds the publish request from the form', () => {
    expect(
      kbPublishRequest({ id: ' kb-a ', titleKey: 't', bodyKey: 'b', baseRevision: '2', category: ' topic ', tags: 'x, y,, ' }),
    ).toEqual({ action: 'kb_publish', id: 'kb-a', titleKey: 't', bodyKey: 'b', baseRevision: 2, category: 'topic', tags: ['x', 'y'] });
    expect(kbPublishRequest(emptyKbForm)).toBeNull();
  });
  it('asks for the second click before hiding an article, and before publishing', () => {
    expect(panel({ step: { kind: 'unpublish', id: 'kb-account-access', revision: 3 } })).toContain(
      'Hide kb-account-access from customers?',
    );
    const publish = panel({ form: { ...emptyKbForm, id: 'kb-a', titleKey: 't', bodyKey: 'b' }, step: { kind: 'publish' } });
    expect(publish).toContain('Publish kb-a?');
    expect(publish).toContain('Yes, publish');
  });
  it('asks for the second click before changing who can read an article, and names the audience', () => {
    const m = panel({ step: { kind: 'audience', id: 'kb-account-access', revision: 3, audience: 'staff' } });
    expect(m).toContain('Make kb-account-access readable by staff only?');
    expect(m).toContain('Yes, change who can read it');
  });
  it('shows each article’s audience, public when the wire says nothing', () => {
    const m = panel();
    expect(m).toContain('Who can read it');
    expect(m).toContain('data-testid="kb-audience"');
    expect(m).toContain('Signed-in customers only');
  });
  it('a forbidden founder sees the reply beside the form, and the controls stay', () => {
    const m = panel({ outcome: FORBIDDEN });
    expect(m).toContain('support operations permission');
    expect(m).toContain('Review publish');
    expect(m).toContain('Unpublish');
  });
  it('empty means svc-support said empty; a failed read is not drawn as empty', () => {
    expect(panel({ kb: kb({ articles: { kind: 'ok', data: [] } }) })).toContain('no articles are published');
    const failed = panel({ kb: kb({ articles: { kind: 'failed', message: 'down', code: null, notBuilt: false, forbidden: false } }) });
    expect(failed).toContain('Help articles unavailable');
    expect(failed).not.toContain('no articles are published');
  });
});

describe('a reply after someone else moved the request', () => {
  const stale: ActionReply = {
    ok: false,
    refusal: { title: 'The request changed since you opened it', body: 'b', next: 'n', code: 'support.stale_ticket', changed: 'no' },
  };
  it('quotes the last row read, and lists the new rows with the button to read them', () => {
    expect(buildRequest('reply', open, form({ replyBody: 'Hi' }), 7)).toEqual({
      action: 'reply',
      ticketId: T1,
      body: 'Hi',
      expectedSequence: 7,
    });
    const markup = html({
      outcome: { kind: 'reply', reply: stale },
      stale: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          ticketId: T1,
          sequence: 3,
          kind: 'status_changed',
          actorId: U,
          actorRole: 'operator',
          fromStatus: 'pending',
          toStatus: 'on_hold',
          note: null,
          occurredAt: '2026-10-29T12:00:00.000Z',
        },
      ],
    });
    expect(markup).toContain('data-code="support.stale_ticket"');
    expect(markup).toContain('#3 status_changed from pending to on_hold');
    expect(buttonTag(markup, 'I have read the changes')).not.toContain('disabled');
  });
  it('holds the reply back while the trail could not be read, and says why', () => {
    const markup = html({ form: form({ replyBody: 'Hi' }), trailUnread: 'The ticket history could not be read.' });
    expect(buttonTag(markup, 'Review reply')).toContain('disabled');
    expect(markup).toContain('The ticket history could not be read.');
  });
});
