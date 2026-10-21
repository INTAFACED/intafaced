import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ATTACHMENT_SCAN_STATES,
  supportAttachmentDownloadSchema,
  supportAttachmentSchema,
} from '@intafaced/contracts/support-attachments';
import {
  SCAN_LABEL,
  addedByLabel,
  canOpen,
  readFileDownload,
  readTicketFile,
  readTicketFiles,
  readUploadParams,
  sizeLabel,
  uploadKey,
} from './files';

const ID = '44444444-4444-4444-8444-444444444444';
const T = '22222222-2222-4222-8222-222222222222';
const U = '11111111-1111-4111-8111-111111111111';
const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  ticketId: T,
  ownerId: U,
  contentType: 'image/png',
  byteLength: 3,
  scanState: 'clean',
  createdAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

describe('readTicketFiles', () => {
  it('reads what the contract writes, for every scan state', () => {
    for (const scanState of SUPPORT_ATTACHMENT_SCAN_STATES) {
      const wire = [supportAttachmentSchema.parse(row({ scanState }))];
      expect(readTicketFiles(wire)).toEqual(wire);
      expect(SCAN_LABEL[scanState]).toBeTruthy();
    }
  });
  it('reads who added a file, and a service that predates the field as the owner', () => {
    const op = '55555555-5555-4555-8555-555555555555';
    expect(readTicketFiles([row({ uploadedBy: op })])?.[0]?.uploadedBy).toBe(op);
    expect(readTicketFiles([row({ uploadedBy: null })])?.[0]?.uploadedBy).toBeNull();
    expect(readTicketFiles([row()])?.[0]?.uploadedBy).toBeNull();
    expect(readTicketFiles([row({ uploadedBy: 'staff' })])).toBeNull();
  });
  it('refuses a store key, a missing key, an unknown state, a bad size and a non-list', () => {
    expect(readTicketFiles([row()])).not.toBeNull();
    expect(readTicketFiles([row({ storeKey: 'k' })])).toBeNull();
    const { scanState: _drop, ...partial } = row();
    expect(readTicketFiles([partial])).toBeNull();
    expect(readTicketFiles([row({ scanState: 'quarantined' })])).toBeNull();
    expect(readTicketFiles([row({ byteLength: -1 })])).toBeNull();
    expect(readTicketFiles([row({ id: 'x' })])).toBeNull();
    expect(readTicketFiles({})).toBeNull();
    expect(readTicketFiles([])).toEqual([]);
  });
});

describe('readFileDownload', () => {
  const body = { id: ID, contentType: 'application/octet-stream', disposition: 'attachment', byteLength: 3, bodyBase64: 'aGkh' };
  it('reads what the contract writes and nothing looser', () => {
    expect(readFileDownload(supportAttachmentDownloadSchema.parse(body))).toEqual({ id: ID, byteLength: 3, bodyBase64: 'aGkh' });
    expect(readFileDownload({ ...body, contentType: 'text/html' })).toBeNull();
    expect(readFileDownload({ ...body, disposition: 'inline' })).toBeNull();
    expect(readFileDownload({ ...body, bodyBase64: 'not base64!' })).toBeNull();
    expect(readFileDownload({ ...body, extra: 1 })).toBeNull();
  });
});

describe('rules', () => {
  it('opens only a clean file', () => {
    expect([canOpen('scanning'), canOpen('clean'), canOpen('blocked')]).toEqual([false, true, false]);
  });
  it('labels sizes', () => {
    expect(sizeLabel(12)).toBe('12 bytes');
    expect(sizeLabel(2048)).toBe('2.0 KB');
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('adding a file', () => {
  const url = (id: string | null, key: string | null) =>
    `http://admin.example/api/support/attachments/upload?${[id ? `id=${id}` : '', key ? `key=${encodeURIComponent(key)}` : ''].filter(Boolean).join('&')}`;
  const key = uploadKey(T, 'a'.repeat(64));

  it('keys the same file on the same ticket to the same retry key, and a different file to another', () => {
    expect(uploadKey(T, 'a'.repeat(64))).toBe(key);
    expect(uploadKey(T, 'b'.repeat(64))).not.toBe(key);
    expect(uploadKey(U, 'a'.repeat(64))).not.toBe(key);
    expect(key.length).toBeLessThanOrEqual(200);
  });
  it('reads the ticket and key from the query and the media type from the header, lower-cased and without parameters', () => {
    expect(readUploadParams(url(T, key), 'Image/PNG; charset=x')).toEqual({ ticketId: T, clientRequestId: key, contentType: 'image/png' });
  });
  it('refuses a missing or bad ticket, key or media type', () => {
    expect(readUploadParams(url(null, key), 'image/png')).toBeNull();
    expect(readUploadParams(url('not-an-id', key), 'image/png')).toBeNull();
    expect(readUploadParams(url(T, null), 'image/png')).toBeNull();
    expect(readUploadParams(url(T, 'has space'), 'image/png')).toBeNull();
    expect(readUploadParams(url(T, 'x'.repeat(201)), 'image/png')).toBeNull();
    expect(readUploadParams(url(T, key), null)).toBeNull();
    expect(readUploadParams(url(T, key), '')).toBeNull();
    expect(readUploadParams(url(T, key), 'image/*')).toBeNull();
    expect(readUploadParams(url(T, key), 'application/json, text/html')).toBeNull();
  });
  it('reads one file strictly, like a list row', () => {
    expect(readTicketFile(row({ uploadedBy: U }))?.uploadedBy).toBe(U);
    expect(readTicketFile(row({ storeKey: 'k' }))).toBeNull();
    expect(readTicketFile(null)).toBeNull();
    expect(readTicketFile([row()])).toBeNull();
  });
  it('says who added a file', () => {
    expect(addedByLabel(readTicketFile(row())!)).toBe('Customer');
    expect(addedByLabel(readTicketFile(row({ uploadedBy: U }))!)).toBe('Support · 11111111');
  });
});
