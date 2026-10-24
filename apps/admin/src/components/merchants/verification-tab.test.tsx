import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import type { KybDocumentReviewView } from '@intafaced/contracts/kyb-documents';
import { VerificationTab } from './verification-tab';

// TEST DATA ONLY: the merchant, application, documents and reviewer stand in for a real review.
const doc = (id: string) => ({
  id,
  contentType: 'application/pdf',
  byteLength: 2048,
  sha256: 'a'.repeat(64),
  uploadedAt: '2026-10-24T06:10:00.000Z',
});
const view: KybDocumentReviewView = {
  merchantId: '11111111-1111-4111-8111-111111111111',
  application: {
    applicationId: 'ab000001-0000-4000-8000-000000000001',
    entityType: 'sole_proprietorship',
    country: 'DE',
    state: 'submitted',
    submittedAt: '2026-10-24T06:20:00.000Z',
  },
  rows: [
    {
      key: 'test_proof_of_identity',
      state: 'provided',
      rejectionReason: null,
      document: doc('ac000001-0000-4000-8000-000000000001'),
      reviewedBy: null,
      reviewedAt: null,
    },
    {
      key: 'test_proof_of_address',
      state: 'rejected',
      rejectionReason: 'TEST cut off at the bottom',
      document: doc('ac000001-0000-4000-8000-000000000002'),
      reviewedBy: '99999999-9999-4999-8999-999999999999',
      reviewedAt: '2026-10-24T06:30:00.000Z',
    },
    { key: 'test_trade_licence', state: 'missing', rejectionReason: null, document: null, reviewedBy: null, reviewedAt: null },
  ],
  vendorCheck: { status: 'not_connected', notConnected: 'vendor.kyc' },
};
const html = (result: Parameters<typeof VerificationTab>[0]['result']) =>
  renderToStaticMarkup(<VerificationTab result={result} here="/merchants/x?tab=verification" />);

describe('verification tab', () => {
  it('lists each document with the merchant’s words, a file to open, and a verdict only for a waiting file', () => {
    const out = html({ kind: 'ok', data: view });
    expect(out).toContain('Sole proprietorship');
    expect(out).toContain('Test proof of identity');
    expect(out).toContain('Waiting for review');
    expect(out).toContain('Mark Test proof of identity Verified');
    expect(out).toContain('Mark Test proof of identity Invalid');
    expect(out).toContain('Invalid');
    expect(out).toContain('Reason given: TEST cut off at the bottom');
    expect(out).toContain('By founder <code title="99999999-9999-4999-8999-999999999999">99999999</code>');
    expect(out).not.toContain('Mark Test proof of address Verified');
    expect(out).toContain('Not sent');
    expect(out).toContain('Open the file for Test proof of identity');
    expect(out).not.toContain('Open the file for Test trade licence');
    expect(out).toContain('No automatic document check');
  });
  it('says plainly when the merchant has no application, and shows a failed read as a failure', () => {
    expect(html({ kind: 'ok', data: { ...view, application: null, rows: [] } })).toContain('No business application');
    const failed = html({ kind: 'forbidden', requestId: null });
    expect(failed).not.toContain('No business application');
    expect(failed).not.toContain('Waiting for review');
  });
});
