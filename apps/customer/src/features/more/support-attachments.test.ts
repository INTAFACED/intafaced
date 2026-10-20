import { describe, expect, it } from 'vitest';
import { attachLimitsView, canDownload, limitsValues, precheckFile, SCAN_STATE_KEY } from './support-attachments';
import { deskCopy } from './support-desk-copy';

const limits = (over: Record<string, unknown> = {}) => ({
  maxBytes: null,
  allowedTypes: null,
  maxCount: null,
  missing: 'support.attachment_store' as const,
  revision: 0,
  updatedAt: null,
  ...over,
});
const set = limits({ maxBytes: 2048, allowedTypes: ['image/png', 'application/pdf'], maxCount: 3, missing: null, revision: 2 });

describe('attachLimitsView', () => {
  it('is off while any piece is missing, and never fills a blank limit', () => {
    expect(attachLimitsView(limits())).toEqual({ kind: 'off' });
    expect(attachLimitsView({ ...set, maxCount: null })).toEqual({ kind: 'off' });
    expect(attachLimitsView({ ...set, missing: 'support.malware_scanner' })).toEqual({ kind: 'off' });
  });
  it('is ready with the owner values when every piece is set', () => {
    const view = attachLimitsView(set);
    expect(view).toEqual({ kind: 'ready', maxBytes: 2048, maxCount: 3, types: ['image/png', 'application/pdf'] });
    if (view.kind === 'ready') {
      expect(limitsValues(view)).toEqual({ count: '3', size: '2 KB', types: 'image/png, application/pdf' });
      expect(deskCopy.t('attachLimitsLine', limitsValues(view))).toBe(
        'Up to 3 files per request, each up to 2 KB. Accepted types: image/png, application/pdf.',
      );
    }
  });
});

describe('precheckFile', () => {
  const ready = attachLimitsView(set);
  it('refuses what the service would, using its own limits', () => {
    expect(precheckFile(ready, { contentType: 'image/png', byteLength: 2049 })).toBe('refuseAttachLarge');
    expect(precheckFile(ready, { contentType: 'image/gif', byteLength: 10 })).toBe('refuseAttachType');
    expect(precheckFile(ready, { contentType: 'image/png', byteLength: 2048 })).toBeNull();
  });
  it('guesses nothing without ready limits', () => {
    expect(precheckFile(null, { contentType: 'image/gif', byteLength: 10 ** 9 })).toBeNull();
    expect(precheckFile({ kind: 'off' }, { contentType: 'image/gif', byteLength: 1 })).toBeNull();
  });
});

describe('scan states', () => {
  it('names each state in plain words and opens only a checked file', () => {
    expect(deskCopy.t(SCAN_STATE_KEY.scanning)).toBe('Being checked');
    expect(deskCopy.t(SCAN_STATE_KEY.clean)).toBe('Checked');
    expect(deskCopy.t(SCAN_STATE_KEY.blocked)).toBe('Not accepted');
    expect([canDownload('scanning'), canDownload('clean'), canDownload('blocked')]).toEqual([false, true, false]);
  });
});
