import { describe, expect, it } from 'vitest';
import type { SupportMergePreview } from '@intafaced/contracts';
import { MERGE_REASON_MAX, emptyMergeForm, mergeConsequence, mergeGate, mergeTargetGate, readMergePreview } from './merge';
import { readActionRequest } from './model';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const preview = (over: Partial<SupportMergePreview> = {}): SupportMergePreview => ({
  sourceId: A,
  survivorId: B,
  refusal: null,
  commentsToMove: 2,
  attachmentsToMove: 1,
  staysOnSource: { rating: false, caseFile: false },
  alreadyMerged: false,
  ...over,
});
const form = { survivorId: B, reason: 'same problem' };

describe('merge request reader', () => {
  it('takes a source, a different survivor and a reason', () => {
    expect(readActionRequest({ action: 'merge', ticketId: A, survivorId: B, reason: ' dup ' })).toEqual({
      action: 'merge',
      ticketId: A,
      survivorId: B,
      reason: 'dup',
    });
  });
  it.each([
    ['the same request twice', { ticketId: A, survivorId: A, reason: 'r' }],
    ['a survivor that is not an id', { ticketId: A, survivorId: 'x', reason: 'r' }],
    ['no reason', { ticketId: A, survivorId: B }],
    ['a blank reason', { ticketId: A, survivorId: B, reason: '  ' }],
    ['a reason past the bound', { ticketId: A, survivorId: B, reason: 'x'.repeat(MERGE_REASON_MAX + 1) }],
  ])('refuses %s', (_n, body) => {
    expect(readActionRequest({ action: 'merge', ...body })).toBeNull();
  });
});

describe('preview reader', () => {
  it('reads exactly the preview shape and nothing else', () => {
    expect(readMergePreview(preview())).toEqual(preview());
    expect(readMergePreview({ ...preview(), extra: 1 })).toBeNull();
    expect(readMergePreview({ ...preview(), refusal: 'support.other' })).toBeNull();
    expect(readMergePreview(null)).toBeNull();
  });
});

describe('gates', () => {
  it('needs a full id that is not this request', () => {
    expect(mergeTargetGate(A, emptyMergeForm).ok).toBe(false);
    expect(mergeTargetGate(A, { survivorId: A, reason: '' }).ok).toBe(false);
    expect(mergeTargetGate(A, form).ok).toBe(true);
  });
  it('arms only with a reason and a preview of exactly this pair that did not refuse', () => {
    expect(mergeGate(A, form, preview(), false).ok).toBe(true);
    expect(mergeGate(A, { ...form, reason: '  ' }, preview(), false).ok).toBe(false);
    expect(mergeGate(A, form, null, false).ok).toBe(false);
    expect(mergeGate(A, form, preview({ survivorId: A }), false).ok).toBe(false);
    expect(mergeGate(A, form, preview({ refusal: 'support.merge_not_allowed' }), false).ok).toBe(false);
    expect(mergeGate(A, form, preview(), true).ok).toBe(false);
  });
});

describe('consequence', () => {
  it('says what moves, what stays, and that it cannot be undone', () => {
    const words = mergeConsequence(preview({ staysOnSource: { rating: true, caseFile: true } }));
    expect(words).toContain('2 messages and 1 file move');
    expect(words).toContain('keeps its rating and its case file');
    expect(words).toContain('This cannot be undone.');
  });
});
