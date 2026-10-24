import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import type { KybRequestsView } from '@intafaced/contracts/kyb-information-requests';
import { VerificationRequests } from './verification-requests';

// TEST DATA ONLY: the merchant, requests, answer and reviewer stand in for a real exchange.
const REVIEWER = '99999999-9999-4999-8999-999999999999';
const base = {
  merchantId: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-10-24T06:00:00.000Z',
  createdBy: REVIEWER,
  answer: null,
  closedBy: null,
  closedAt: null,
  closeNote: null,
};
const view: KybRequestsView = {
  merchantId: base.merchantId,
  uploadRules: { maxBytes: 1_048_576, contentTypes: ['application/pdf'] },
  scanner: { status: 'connected' },
  requests: [
    {
      ...base,
      id: 'ae000001-0000-4000-8000-000000000003',
      text: 'TEST a utility bill',
      dueAt: '2026-10-24T07:00:00.000Z',
      state: 'open',
      pastDue: true,
    },
    {
      ...base,
      id: 'ae000001-0000-4000-8000-000000000002',
      text: 'TEST a bank statement',
      dueAt: '2026-11-07T12:00:00.000Z',
      state: 'answered',
      pastDue: false,
      answer: {
        note: 'TEST here it is',
        file: { id: 'af000001-0000-4000-8000-000000000001', contentType: 'application/pdf', byteLength: 120, sha256: 'b'.repeat(64) },
        answeredAt: '2026-10-24T06:30:00.000Z',
      },
    },
    {
      ...base,
      id: 'ae000001-0000-4000-8000-000000000001',
      text: 'TEST the shareholder register',
      dueAt: '2026-11-01T12:00:00.000Z',
      state: 'closed',
      pastDue: false,
      closedBy: REVIEWER,
      closedAt: '2026-10-24T06:40:00.000Z',
      closeNote: 'TEST no longer needed',
    },
  ],
};
const html = (result: Parameters<typeof VerificationRequests>[0]['result']) =>
  renderToStaticMarkup(<VerificationRequests merchantId={base.merchantId} result={result} here="/merchants/x?tab=verification" />);

describe('information requests card', () => {
  it('shows past due, the answer and its file, and who closed a request; only open ones can be closed', () => {
    const out = html({ kind: 'ok', data: view });
    const [, pastDue = '', answered = '', closed = ''] = out.split('data-testid="kyb-request"');
    expect(pastDue).toMatch(/>Past due</);
    expect(pastDue).toContain('Close request 3');
    expect(answered).toContain('Merchant’s note: TEST here it is');
    expect(answered).toContain('passed the malware scan');
    expect(answered).toContain('Open the file sent for request 2');
    expect(closed).toContain(`Closed by <code title="${REVIEWER}">99999999</code>`);
    expect(closed).toContain('TEST no longer needed');
    expect(closed).not.toContain('Close request 1');
    expect(out).toContain('Send request');
    expect(out).not.toContain('No malware scanner connected');
  });
  it('says when nothing was asked and when no scanner is connected, and shows a failed read as a failure', () => {
    const empty = html({
      kind: 'ok',
      data: { ...view, requests: [], scanner: { status: 'not_connected', notConnected: 'vendor.malware_scan' } },
    });
    expect(empty).toContain('No information requests');
    expect(empty).toContain('No malware scanner connected');
    expect(html({ kind: 'forbidden', requestId: null })).not.toContain('No information requests');
  });
});
