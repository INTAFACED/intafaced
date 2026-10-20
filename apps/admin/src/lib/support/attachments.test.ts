import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ATTACHMENT_KEYS,
  SUPPORT_ATTACHMENT_REASON_MAX,
  SUPPORT_ATTACHMENT_TYPES_MAX,
  supportAttachmentStatusSchema,
  supportAttachmentTypeProblem,
} from '@intafaced/contracts/support-attachments';
import {
  ATTACHMENT_KEYS,
  REASON_MAX,
  attachmentChanges,
  attachmentDraftsFrom,
  attachmentGate,
  parseTypeList,
  readAttachmentSetRequest,
  readAttachmentStatus,
  type AttachmentLimits,
} from './attachments';

const limits = (over: Partial<AttachmentLimits> = {}): AttachmentLimits => ({
  maxBytes: null,
  allowedTypes: null,
  maxCount: null,
  missing: 'support.attachment_store',
  revision: 0,
  updatedAt: null,
  ...over,
});
const status = (over: Partial<AttachmentLimits> = {}, set: boolean[] = [false, false, false, false, false]) => ({
  pieces: ATTACHMENT_KEYS.map((key, i) => ({ key, set: set[i]! })),
  limits: limits(over),
});

describe('pinned to the contract', () => {
  it('uses the contract key order, reason bound and media type rule', () => {
    expect([...ATTACHMENT_KEYS]).toEqual([...SUPPORT_ATTACHMENT_KEYS]);
    expect(REASON_MAX).toBe(SUPPORT_ATTACHMENT_REASON_MAX);
    for (const t of ['image/png', 'application/pdf', 'image/*', 'Image/png', 'text/plain; charset=utf-8', 'png', '', 'a/b/c']) {
      const parsed = parseTypeList(t);
      expect(parsed.ok && parsed.value !== null).toBe(supportAttachmentTypeProblem(t) === null);
    }
    expect(parseTypeList(Array.from({ length: SUPPORT_ATTACHMENT_TYPES_MAX + 1 }, (_, i) => `a/b${i}`).join(',')).ok).toBe(false);
  });
  it('reads what the contract writes', () => {
    const wire = supportAttachmentStatusSchema.parse({
      pieces: SUPPORT_ATTACHMENT_KEYS.map((key) => ({ key, set: true })),
      limits: { maxBytes: 10, allowedTypes: ['image/png'], maxCount: 3, missing: null, revision: 2, updatedAt: '2026-10-20T10:00:00.000Z' },
    });
    expect(readAttachmentStatus(wire)).toEqual(wire);
  });
});

describe('readAttachmentStatus', () => {
  it('reads blank limits as null and invents nothing', () => {
    expect(readAttachmentStatus(status())).toMatchObject({ limits: { maxBytes: null, allowedTypes: null, maxCount: null } });
  });
  it('refuses an extra key, a wrong piece order, a zero limit, a bad type list and a bad missing key', () => {
    expect(readAttachmentStatus({ ...status(), extra: 1 })).toBeNull();
    const swapped = status();
    expect(readAttachmentStatus({ ...swapped, pieces: [...swapped.pieces].reverse() })).toBeNull();
    expect(readAttachmentStatus({ ...status(), pieces: status().pieces.slice(1) })).toBeNull();
    expect(readAttachmentStatus(status({ maxBytes: 0 }))).toBeNull();
    expect(readAttachmentStatus(status({ maxCount: 1.5 }))).toBeNull();
    expect(readAttachmentStatus(status({ allowedTypes: [] }))).toBeNull();
    expect(readAttachmentStatus(status({ allowedTypes: ['image/*'] }))).toBeNull();
    expect(readAttachmentStatus(status({ allowedTypes: ['image/png', 'image/png'] }))).toBeNull();
    expect(readAttachmentStatus(status({ missing: 'support.nope' as never }))).toBeNull();
    expect(readAttachmentStatus(status({ revision: -1 }))).toBeNull();
    expect(readAttachmentStatus(status({ updatedAt: 'soon' }))).toBeNull();
    expect(readAttachmentStatus(null)).toBeNull();
  });
});

describe('attachmentChanges', () => {
  const stored = limits({ maxBytes: 1000, allowedTypes: ['image/png', 'application/pdf'], maxCount: 3, missing: null, revision: 2 });
  it('sends nothing when nothing differs, whatever the separators', () => {
    expect(attachmentChanges(stored, attachmentDraftsFrom(stored))).toEqual({ ok: true, changes: null });
    expect(attachmentChanges(stored, { maxBytes: ' 1000 ', allowedTypes: 'image/png, application/pdf', maxCount: '3' })).toEqual({
      ok: true,
      changes: null,
    });
  });
  it('sets what differs, clears what was emptied and leaves the rest out', () => {
    expect(attachmentChanges(stored, { maxBytes: '2000', allowedTypes: '', maxCount: '3' })).toEqual({
      ok: true,
      changes: { maxBytes: 2000, allowedTypes: null },
    });
  });
  it('an empty field that was never set is not a change', () => {
    expect(attachmentChanges(limits(), { maxBytes: '', allowedTypes: '', maxCount: '' })).toEqual({ ok: true, changes: null });
  });
  it('says why a value cannot be sent', () => {
    expect(attachmentChanges(limits(), { maxBytes: '1e6', allowedTypes: '', maxCount: '' })).toMatchObject({ ok: false });
    expect(attachmentChanges(limits(), { maxBytes: '0', allowedTypes: '', maxCount: '' })).toMatchObject({ ok: false });
    expect(attachmentChanges(limits(), { maxBytes: '', allowedTypes: 'image/*', maxCount: '' })).toMatchObject({ ok: false });
    expect(attachmentChanges(limits(), { maxBytes: '', allowedTypes: 'image/png image/png', maxCount: '' })).toMatchObject({ ok: false });
  });
});

describe('attachmentGate', () => {
  const c = limits({ maxCount: 3 });
  const drafts = { maxBytes: '', allowedTypes: '', maxCount: '4' };
  it('needs a change and a reason', () => {
    expect(attachmentGate(c, attachmentDraftsFrom(c), 'why', false)).toEqual({ ok: false, why: 'Nothing has changed.' });
    expect(attachmentGate(c, drafts, '  ', false)).toEqual({ ok: false, why: 'Say why you are changing it.' });
    expect(attachmentGate(c, drafts, 'x'.repeat(501), false).ok).toBe(false);
    expect(attachmentGate(c, drafts, 'raise it', false)).toEqual({ ok: true });
    expect(attachmentGate(c, drafts, 'raise it', true).ok).toBe(false);
  });
});

describe('readAttachmentSetRequest', () => {
  const base = { changes: { maxBytes: 5, allowedTypes: ['image/png'], maxCount: null }, expectedRevision: 1, reason: ' r ' };
  it('reads a request and trims the reason', () => {
    expect(readAttachmentSetRequest(base)).toEqual({ ...base, reason: 'r' });
  });
  it('refuses no changes, an unknown field, bad values, a bad revision and a missing reason', () => {
    expect(readAttachmentSetRequest({ ...base, changes: {} })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, changes: { store: 'x' } })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, changes: { maxBytes: 0 } })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, changes: { maxBytes: '5' } })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, changes: { allowedTypes: [] } })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, changes: { allowedTypes: ['image/*'] } })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, changes: { allowedTypes: ['a/b', 'a/b'] } })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, expectedRevision: -1 })).toBeNull();
    expect(readAttachmentSetRequest({ ...base, reason: ' ' })).toBeNull();
  });
});
