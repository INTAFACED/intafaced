import { describe, expect, it } from 'vitest';
import { kybDocumentChecklistViewSchema, kybDocumentsUploadInputSchema } from './kyb-documents.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('kyb documents contracts', () => {
  it('accepts a checklist with the vendor check not connected', () => {
    const view = kybDocumentChecklistViewSchema.parse({
      applicationId: id,
      uploadRules: null,
      rows: [{ key: 'certificate_of_incorporation', state: 'missing', rejectionReason: null, document: null }],
      vendorCheck: { status: 'not_connected', notConnected: 'vendor.kyc' },
    });
    expect(view.rows[0]?.state).toBe('missing');
  });

  it('refuses an unknown state and a made-up vendor check', () => {
    const base = { applicationId: id, uploadRules: null, rows: [], vendorCheck: { status: 'not_connected', notConnected: 'vendor.kyc' } };
    expect(() =>
      kybDocumentChecklistViewSchema.parse({ ...base, rows: [{ key: 'ab', state: 'ok', rejectionReason: null, document: null }] }),
    ).toThrow();
    expect(() =>
      kybDocumentChecklistViewSchema.parse({ ...base, vendorCheck: { status: 'passed', notConnected: 'vendor.kyc' } }),
    ).toThrow();
  });

  it('refuses an upload with a bad key or extra fields', () => {
    const ok = { applicationId: id, key: 'certificate_of_incorporation', contentType: 'application/pdf', bytesBase64: 'AAAA' };
    expect(kybDocumentsUploadInputSchema.parse(ok).key).toBe('certificate_of_incorporation');
    expect(() => kybDocumentsUploadInputSchema.parse({ ...ok, key: 'Bad Key' })).toThrow();
    expect(() => kybDocumentsUploadInputSchema.parse({ ...ok, maxBytes: 1 })).toThrow();
  });
});
