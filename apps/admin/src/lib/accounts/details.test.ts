import { describe, expect, it } from 'vitest';
import { customerDetailsResultSchema } from '@intafaced/contracts';
import { detailsReply, historyOutcome, isProtectedDetail } from './details';
import { keyUuid, readDecideForm, readEditForm } from './details-forms';

const USER = '0b6f7a3e-1111-4111-8111-111111111111';
const REVIEW = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const edit = (raw: unknown, founder = A) => readEditForm(raw, founder);
const decide = (raw: unknown, founder = A) => readDecideForm(raw, founder);
const form = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  field: 'legalName',
  value: 'Ada Lovelace',
  reason: 'Customer letter of 20 Oct',
  basis: { version: '3', after: null },
  ...over,
});

describe('the details edit form', () => {
  it('makes a UUID from a business key, the same each time', () => {
    const one = keyUuid('console:details-edit:x');
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keyUuid('console:details-edit:x')).toBe(one);
    expect(keyUuid('console:details-edit:y')).not.toBe(one);
  });

  it('keys an edit by the reading it was made on, so asking again is the same request and a new reading is not', () => {
    const first = edit(form())!;
    expect(first).toMatchObject({ userId: USER, field: 'legalName', value: 'Ada Lovelace', expectedVersion: '3' });
    expect(edit(form({ value: 'Ada King' }))!.requestId).toBe(first.requestId);
    expect(edit(form({ basis: { version: '4', after: null } }))!.requestId).not.toBe(first.requestId);
    // A refused edit or a rejected review leaves the version as it was but adds a history entry: the next ask is a new request.
    const afterRefusal = edit(form({ value: 'Ada King', basis: { version: '3', after: REVIEW } }))!;
    expect(afterRefusal.requestId).not.toBe(first.requestId);
    expect(edit(form({ value: 'Ada King', basis: { version: '3', after: REVIEW.toUpperCase() } }))!.requestId).toBe(afterRefusal.requestId);
    expect(edit(form({ field: 'taxNumber' }))!.requestId).not.toBe(first.requestId);
    // Another founder's edit on the same reading is another request.
    expect(edit(form(), B)!.requestId).not.toBe(first.requestId);
  });

  it('takes null as "off the record" and refuses a bad value, field, reason or reading before anything is sent', () => {
    expect(edit(form({ field: 'city', value: null }))).toMatchObject({ field: 'city', value: null });
    expect(edit(form({ field: 'dateOfBirth', value: '1990-02-30' }))).toBeNull();
    expect(edit(form({ field: 'countryCode', value: 'gb' }))).toBeNull();
    expect(edit(form({ field: 'nickname' }))).toBeNull();
    expect(edit(form({ reason: 'too short' }))).toBeNull();
    expect(edit(form({ basis: { version: '03', after: null } }))).toBeNull();
    expect(edit(form({ basis: { version: '3', after: 'x' } }))).toBeNull();
    expect(edit(form({ basis: { version: '3', reviewId: null, reviewStatus: null } }))).toBeNull();
    expect(edit({ ...form(), extra: true })).toBeNull();
  });

  it('keys a decision by its review and outcome', () => {
    const pass = decide({ userId: USER, reviewId: REVIEW, decision: 'pass', note: 'Passport checked in full' })!;
    expect(pass).toMatchObject({ userId: USER, reviewId: REVIEW, decision: 'pass' });
    expect(decide({ userId: USER, reviewId: REVIEW, decision: 'pass', note: 'Other words, same decision' })!.requestId).toBe(
      pass.requestId,
    );
    expect(decide({ userId: USER, reviewId: REVIEW, decision: 'reject', note: 'Passport checked in full' })!.requestId).not.toBe(
      pass.requestId,
    );
    expect(decide({ userId: USER, reviewId: REVIEW, decision: 'pass', note: 'Passport checked in full' }, B)!.requestId).not.toBe(
      pass.requestId,
    );
    expect(decide({ userId: USER, reviewId: REVIEW, decision: 'approve', note: 'Passport checked in full' })).toBeNull();
  });
});

describe('what identity answered, in words', () => {
  const base = {
    auditId: REVIEW,
    requestId: REVIEW,
    userId: USER,
    fields: ['legalName'],
    reason: 'Customer letter of 20 Oct',
    occurredAt: '2026-10-24T19:00:00.000Z',
  };
  it('names the fields and says only an applied change changed the record', () => {
    expect(isProtectedDetail('legalName')).toBe(true);
    expect(isProtectedDetail('city')).toBe(false);
    const opened = customerDetailsResultSchema.parse({
      ...base,
      outcome: 'review_opened',
      changed: false,
      actorUserId: USER,
      reviewId: REVIEW,
      version: '3',
    });
    expect(detailsReply(opened)).toEqual({
      ok: true,
      text: 'Compliance review opened for Legal name. The record keeps the old value until the other founder passes it.',
    });
    const passed = customerDetailsResultSchema.parse({
      ...base,
      outcome: 'applied',
      changed: true,
      actorUserId: USER,
      reviewId: REVIEW,
      version: '4',
    });
    expect(detailsReply(passed).text).toBe('Review passed: identity applied Legal name (record version 4).');
    const self = customerDetailsResultSchema.parse({
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: USER,
      reviewId: REVIEW,
      code: 'identity.details_review_self_forbidden',
    });
    expect(detailsReply(self)).toMatchObject({ ok: false, text: expect.stringContaining('the other founder decides the review') });
    expect(historyOutcome(self)).toBe('refused (identity.details_review_self_forbidden)');
  });
});
