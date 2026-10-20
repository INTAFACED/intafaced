import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ATTACHMENT_SCAN_STATES,
  supportAttachmentDownloadSchema,
  supportAttachmentSchema,
} from '@intafaced/contracts/support-attachments';
import { SCAN_LABEL, canOpen, readFileDownload, readTicketFiles, sizeLabel } from './files';

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
