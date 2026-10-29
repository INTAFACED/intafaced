import { describe, expect, it } from 'vitest';
import type { FounderCallFailure } from '@/lib/desk/founder-call';
import { SUPPORT_OPS_FORBIDDEN, explainSupportFailure, supportCodeOf } from './refusal';

const refusal = (message: string, status: number, code: string | null = null) => ({ code, message, status });
const refused = (message: string, status = 412, code: string | null = null): FounderCallFailure<unknown> => ({
  kind: 'refused',
  refusal: refusal(message, status, code),
  requestId: null,
});

describe('a forbidden answer', () => {
  it('is the support-operations message, said the same way everywhere, and nothing changed', () => {
    const view = explainSupportFailure({ kind: 'forbidden', refusal: refusal('scope.denied', 403), requestId: null });
    expect(view.title).toBe('Your console session does not have support operations permission');
    expect(SUPPORT_OPS_FORBIDDEN).toBe(view.title);
    expect(view.changed).toBe('no');
    expect(view.body).toContain('support:ops');
  });
  it('is not blamed on permission when the session simply ended', () => {
    const view = explainSupportFailure({ kind: 'forbidden', refusal: refusal('x', 401), requestId: null });
    expect(view.title).toBe('You are signed out');
  });
});

describe('svc-support’s typed refusals', () => {
  it.each([
    ['support.transition_illegal', 'svc-support does not allow that status change'],
    ['support.transition_same_status', 'The ticket is already in that status'],
    ['support.hold_reason_required', 'Say why the request is on hold'],
    ['support.comment.terminal', 'This ticket is closed'],
    ['support.escalation.terminal', 'A closed ticket cannot be escalated'],
    ['support.case_file.ungrounded', 'The escalation cites nothing that was read'],
    ['support.case_file.empty_summary', 'The summary is empty'],
    ['support.order.user_mismatch', "That order is a different customer's"],
    ['support.identity_grounding_unwired', 'The support desk cannot read account state'],
    ['support.settle.refused', 'svc-support will not do that to a money request'],
    ['support.kb.revision_stale', 'Someone changed this article first'],
    ['support.kb.not_published', 'That article is not published'],
    ['support.kb_invalid', 'svc-support did not accept that article'],
    ['support.kb_vendor_name', 'Article keys may not name another company’s product'],
    ['support.not_found', 'No such ticket'],
    ['support.macro_not_found', 'No such macro'],
    ['support.macro_placeholder_blank', 'A placeholder is still unfilled'],
    ['support.macro_placeholder_unknown', 'That placeholder does not exist'],
    ['support.macro_revision_stale', 'It changed since you read it'],
    ['support.shortcode_taken', 'That shortcode is taken'],
    ['support.shortcode_too_short', 'That shortcode is too short'],
    ['support.shortcode_rule_unset', 'The shortcode rule is not set'],
  ])('%s reads as "%s" and changed nothing', (code, title) => {
    const view = explainSupportFailure(refused(code));
    expect(view).toMatchObject({ title, code, changed: 'no' });
    expect(view.body).not.toMatch(/support\.[a-z_]/);
  });
  it('finds the code inside a longer message', () => {
    expect(supportCodeOf('Refused: support.transition_illegal (open -> open)', null)).toBe('support.transition_illegal');
    expect(supportCodeOf('no code here', null)).toBeNull();
  });
  it('a not-found by class gets the not-found answer even when the service hides the code', () => {
    expect(explainSupportFailure(refused('Not found', 404)).title).toBe('No such ticket');
  });
  it('an unknown refusal falls back to the general answers, never a raw code in the title', () => {
    const view = explainSupportFailure(refused('support.something_new', 400));
    expect(view.title).toBe('The service refused this');
    expect(view.changed).toBe('no');
  });
});

describe('the answers that are not refusals', () => {
  it('a write that may have reached the service is "not known"', () => {
    expect(explainSupportFailure({ kind: 'unavailable', uncertain: true, requestId: null }).changed).toBe('unknown');
  });
  it('a service that has not switched this on says so', () => {
    expect(explainSupportFailure({ kind: 'not_built', procedure: 'escalate', requestId: null })).toMatchObject({
      code: 'not_built',
      changed: 'no',
    });
  });
  it('an unreadable success is "not known", never done', () => {
    expect(explainSupportFailure({ kind: 'invalid', requestId: null }).changed).toBe('unknown');
  });
});

describe('the owner refusals', () => {
  it.each([
    ['support.release.not_assignee', 'Only the person holding the request can unclaim it'],
    ['support.not_lead', 'Only a lead can do that'],
  ])('a forbidden %s is that refusal, with its code, not a missing permission', (code, title) => {
    const view = explainSupportFailure({ kind: 'forbidden', refusal: refusal(code, 403), requestId: null });
    expect([view.title, view.code, view.changed]).toEqual([title, code, 'no']);
  });
  it.each([
    ['support.stale_ticket', 'The request changed since you opened it', 409],
    ['support.claim.queue_empty', 'No request is waiting to be claimed', 412],
    ['support.claim.already_claimed', 'Someone else already holds this request', 409],
  ])('%s says what happened, with its code', (code, title, status) => {
    const view = explainSupportFailure(refused(code, status));
    expect([view.title, view.code, view.changed]).toEqual([title, code, 'no']);
  });
});
