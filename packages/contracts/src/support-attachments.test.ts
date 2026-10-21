import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ATTACHMENT_KEYS,
  supportAttachmentDownloadSchema,
  supportAttachmentLimitsSchema,
  supportAttachmentSchema,
  supportAttachmentSetKey,
  supportAttachmentSettingsSetInputSchema,
  supportAttachmentStatusSchema,
  supportAttachmentTypeProblem,
} from './support-attachments.js';
import * as root from './index.js';

const blank = { maxBytes: null, allowedTypes: null, maxCount: null, missing: 'support.attachment_store', revision: 0, updatedAt: null };

describe('support attachment limits', () => {
  it('reads a blank limit as null and names what is missing, never a built-in value', () => {
    expect(supportAttachmentLimitsSchema.parse(blank)).toEqual(blank);
    expect(supportAttachmentLimitsSchema.safeParse({ ...blank, maxBytes: 0 }).success).toBe(false);
    expect(supportAttachmentLimitsSchema.safeParse({ ...blank, allowedTypes: [] }).success).toBe(false);
    expect(supportAttachmentLimitsSchema.safeParse({ ...blank, missing: 'support.nothing' }).success).toBe(false);
    expect(supportAttachmentLimitsSchema.safeParse({ ...blank, extra: 1 }).success).toBe(false);
  });

  it.each([
    ['image/png', null],
    ['application/pdf', null],
    ['image/svg+xml', null],
    ['image/*', 'not_a_media_type'],
    ['IMAGE/PNG', 'not_a_media_type'],
    ['image/png; charset=x', 'not_a_media_type'],
    ['image', 'not_a_media_type'],
    ['', 'not_a_media_type'],
    ['image/png\n', 'not_a_media_type'],
  ])('judges the media type %j', (value, problem) => {
    expect(supportAttachmentTypeProblem(value)).toBe(problem);
  });

  it('takes a change that sets any one limit and refuses an empty one, a duplicate type and a bad count', () => {
    const base = { expectedRevision: 0, reason: ' why ' };
    expect(supportAttachmentSettingsSetInputSchema.parse({ ...base, maxBytes: 1000 })).toEqual({
      expectedRevision: 0,
      reason: 'why',
      maxBytes: 1000,
    });
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, maxCount: null }).success).toBe(true);
    expect(supportAttachmentSettingsSetInputSchema.safeParse(base).success).toBe(false);
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, maxBytes: 1.5 }).success).toBe(false);
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, maxCount: 0 }).success).toBe(false);
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, allowedTypes: ['image/png', 'image/png'] }).success).toBe(false);
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, allowedTypes: ['image/*'] }).success).toBe(false);
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, maxBytes: 1, reason: '  ' }).success).toBe(false);
    expect(supportAttachmentSettingsSetInputSchema.safeParse({ ...base, maxBytes: 1, store: 'x' }).success).toBe(false);
  });

  it('keys a change by the revision it moves from', () => {
    expect(supportAttachmentSetKey(3)).toBe('support.attachment_settings:r3');
  });

  it('lists the five pieces and refuses a status that is short of one', () => {
    const pieces = SUPPORT_ATTACHMENT_KEYS.map((key) => ({ key, set: false }));
    expect(supportAttachmentStatusSchema.safeParse({ pieces, limits: blank }).success).toBe(true);
    expect(supportAttachmentStatusSchema.safeParse({ pieces: pieces.slice(1), limits: blank }).success).toBe(false);
  });
});

describe('support attachment records', () => {
  const file = {
    id: '11111111-1111-4111-8111-111111111111',
    ticketId: '22222222-2222-4222-8222-222222222222',
    ownerId: '33333333-3333-4333-8333-333333333333',
    contentType: 'image/png',
    byteLength: 10,
    scanState: 'clean',
    uploadedBy: null,
    createdAt: '2026-10-20T10:00:00.000Z',
  };

  it('carries a scan state and no store key', () => {
    expect(supportAttachmentSchema.parse(file)).toEqual(file);
    expect(supportAttachmentSchema.safeParse({ ...file, storeKey: 'a/b' }).success).toBe(false);
    expect(supportAttachmentSchema.safeParse({ ...file, scanState: 'unknown' }).success).toBe(false);
  });

  it('names the operator who added a file, or null when its owner did or the service predates the field, and nothing else', () => {
    const operator = '44444444-4444-4444-8444-444444444444';
    expect(supportAttachmentSchema.parse({ ...file, uploadedBy: operator }).uploadedBy).toBe(operator);
    expect(supportAttachmentSchema.safeParse({ ...file, uploadedBy: 'staff' }).success).toBe(false);
    const { uploadedBy: _omitted, ...without } = file;
    expect(supportAttachmentSchema.parse(without).uploadedBy).toBeNull();
  });

  it('serves only a fixed content type, always as a download', () => {
    const download = { id: file.id, contentType: 'application/octet-stream', disposition: 'attachment', byteLength: 3, bodyBase64: 'AAEC' };
    expect(supportAttachmentDownloadSchema.parse(download)).toEqual(download);
    expect(supportAttachmentDownloadSchema.safeParse({ ...download, contentType: 'text/html' }).success).toBe(false);
    expect(supportAttachmentDownloadSchema.safeParse({ ...download, disposition: 'inline' }).success).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.supportAttachmentLimitsSchema).toBe(supportAttachmentLimitsSchema);
  });
});
