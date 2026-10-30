import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../shared/api';
import { actionFailurePresentation } from './common';
import { deskCopy } from './support-desk-copy';
import { plainSupportResult, supportRefusalKey } from './support-refusal';

const fail = (over: Partial<Extract<ApiResult<unknown>, { ok: false }>>): Extract<ApiResult<unknown>, { ok: false }> => ({
  ok: false,
  reason: 'error',
  message: '',
  ...over,
});

describe('which sentence answers a support refusal', () => {
  it.each([
    ['support.already_rated', 'refuseAlreadyRated'],
    ['support.rate_status_refused', 'refuseRateNotYet'],
    ['support.rate_score_out_of_range', 'refuseRateScore'],
    ['support.rate_note_too_long', 'refuseRateNote'],
    ['support.transition_same_status', 'refuseAlreadyClosed'],
    ['support.transition_illegal', 'refuseCannotClose'],
    ['support.settle.refused', 'refuseTeamHandling'],
    ['support.attachment_count_unset', 'refuseAttachOff'],
    ['support.attachment_count_reached', 'refuseAttachCount'],
    ['support.attachment_scan_unknown', 'refuseAttachHeld'],
    ['support.attachment_scan_refused', 'refuseAttachScan'],
    ['support.attachment_too_large', 'refuseAttachLarge'],
    ['support.attachment_type_refused', 'refuseAttachType'],
    ['support.attachment_body_invalid', 'refuseAttachUnreadable'],
    ['support.kb.not_published', 'refuseArticleGone'],
    ['support.comment_cap_unset', 'refuseCommentsOff'],
    ['support.comment_cap_reached', 'refuseCommentCap'],
    ['support.comment_secret_refused', 'refuseCommentSecret'],
  ] as const)('%s reads as %s', (code, key) => {
    expect(supportRefusalKey(fail({ message: code, code: 'CONFLICT', status: 409 }))).toBe(key);
  });

  it('says attachments are off and never repeats the engineering key the service names', () => {
    const failure = fail({
      message: 'support.attachments_unconfigured support.attachment_store',
      code: 'PRECONDITION_FAILED',
      status: 412,
    });
    expect(supportRefusalKey(failure)).toBe('refuseAttachOff');
    const plain = plainSupportResult(failure);
    expect(plain).toMatchObject({ ok: false, message: deskCopy.t('refuseAttachOff') });
    expect(plain.ok === false && plain.message).not.toContain('support.');
  });

  it('answers a not-found by its class, since the service hides which one it was', () => {
    expect(supportRefusalKey(fail({ reason: 'not_mounted', message: 'Not found', code: 'NOT_FOUND', status: 404 }))).toBe('refuseNotFound');
  });

  it('says a reused key changed request only for the action that names it', () => {
    const conflict = fail({ message: 'support.idempotency_conflict', code: 'CONFLICT', status: 409 });
    expect(supportRefusalKey(conflict)).toBe('refuseGeneric');
    expect(supportRefusalKey(conflict, { 'support.idempotency_conflict': 'refuseReplyChanged' })).toBe('refuseReplyChanged');
  });

  it('gives an unknown support code a plain sentence, not the dotted code', () => {
    const plain = plainSupportResult(fail({ message: 'support.something_new', code: 'BAD_REQUEST', status: 400 }));
    expect(plain).toMatchObject({ ok: false, message: deskCopy.t('refuseGeneric') });
  });

  it('answers a refused or expired session in plain words', () => {
    expect(supportRefusalKey(fail({ reason: 'forbidden', message: 'x', status: 403 }))).toBe('refuseForbidden');
    expect(supportRefusalKey(fail({ reason: 'unauthorized', message: 'x', status: 401 }))).toBe('refuseSignedOut');
  });

  it('leaves an unconfirmed outcome exactly as it came, so "we do not know" is never rewritten as "it failed"', () => {
    for (const reason of ['uncertain', 'aborted', 'unreachable'] as const) {
      const failure = fail({ reason, message: 'support.already_rated' });
      expect(supportRefusalKey(failure)).toBeNull();
      expect(plainSupportResult(failure)).toBe(failure);
    }
  });

  it('leaves a refusal that is not from the support service alone', () => {
    const failure = fail({ message: 'Something else happened', code: 'INTERNAL' });
    expect(plainSupportResult(failure)).toBe(failure);
  });

  it('passes a success through untouched', () => {
    const ok: ApiResult<number> = { ok: true, data: 1 };
    expect(plainSupportResult(ok)).toBe(ok);
  });

  it('registers the sentence so it follows the interface language', () => {
    const plain = plainSupportResult(fail({ message: 'support.already_rated', code: 'CONFLICT', status: 409 }));
    expect(actionFailurePresentation(plain, 'en')).toEqual({ message: deskCopy.t('refuseAlreadyRated'), language: 'en' });
  });
});

describe('phishing report refusals', () => {
  it('reads support.headers_not_allowed as its own plain sentence', () => {
    expect(supportRefusalKey(fail({ message: 'support.headers_not_allowed', code: 'BAD_REQUEST', status: 400 }))).toBe(
      'refuseHeadersNotAllowed',
    );
  });

  it('reads support.follow_up_invalid as its own plain sentence', () => {
    expect(supportRefusalKey(fail({ message: 'support.follow_up_invalid', code: 'PRECONDITION_FAILED', status: 412 }))).toBe(
      'refuseFollowUp',
    );
  });
});
