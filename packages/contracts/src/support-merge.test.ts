import { describe, expect, it } from 'vitest';
import { SUPPORT_MERGE_REASON_MAX, supportMergeInputSchema, supportMergePreviewSchema, supportMergeResultSchema } from './support-merge.js';
import { supportTicketEventKindSchema, supportTicketSchema } from './support.js';
import * as root from './index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('merge input', () => {
  it('needs a source, a survivor and a reason', () => {
    expect(supportMergeInputSchema.safeParse({ sourceId: A, survivorId: B, reason: 'same issue' }).success).toBe(true);
    expect(supportMergeInputSchema.safeParse({ sourceId: A, survivorId: B }).success).toBe(false);
    expect(supportMergeInputSchema.safeParse({ sourceId: A, survivorId: B, reason: '   ' }).success).toBe(false);
    expect(supportMergeInputSchema.safeParse({ sourceId: A, survivorId: 'x', reason: 'r' }).success).toBe(false);
  });
  it('refuses an extra key and a reason past the bound', () => {
    expect(supportMergeInputSchema.safeParse({ sourceId: A, survivorId: B, reason: 'r', key: 'k' }).success).toBe(false);
    expect(
      supportMergeInputSchema.safeParse({ sourceId: A, survivorId: B, reason: 'x'.repeat(SUPPORT_MERGE_REASON_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('merge result and preview', () => {
  it('parse their own shapes', () => {
    const at = '2026-10-21T00:00:00.000Z';
    expect(
      supportMergeResultSchema.safeParse({ sourceId: A, survivorId: B, commentsMoved: 2, attachmentsMoved: 0, mergedAt: at }).success,
    ).toBe(true);
    const preview = {
      sourceId: A,
      survivorId: B,
      refusal: null,
      commentsToMove: 1,
      attachmentsToMove: 1,
      staysOnSource: { rating: true, caseFile: false },
      alreadyMerged: false,
    };
    expect(supportMergePreviewSchema.safeParse(preview).success).toBe(true);
    expect(supportMergePreviewSchema.safeParse({ ...preview, refusal: 'support.other' }).success).toBe(false);
  });
});

describe('ticket link and trail', () => {
  it('carries mergedInto and a merged trail kind', () => {
    expect(supportTicketEventKindSchema.safeParse('merged').success).toBe(true);
    const t = {
      id: A,
      userId: B,
      category: 'other',
      subject: 's',
      body: 'b',
      status: 'closed',
      assigneeId: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    };
    expect(supportTicketSchema.parse(t).mergedInto).toBeUndefined();
    expect(supportTicketSchema.parse({ ...t, mergedInto: B }).mergedInto).toBe(B);
    expect(supportTicketSchema.parse({ ...t, mergedInto: null }).mergedInto).toBeNull();
  });
  it('is exported from the package root', () => {
    expect(root.supportMergeInputSchema).toBe(supportMergeInputSchema);
  });
});
