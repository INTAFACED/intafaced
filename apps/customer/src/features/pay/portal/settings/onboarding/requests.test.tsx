import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { failed, noop, plain, ready } from '../account/testing';
import { InformationRequestsView } from './Requests';
import type { RequestsView } from './requests-api';

// TEST DATA ONLY: the requests, answer and reviewer stand in for what INTAFACED asks.
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
const view: RequestsView = {
  merchantId: base.merchantId,
  uploadRules: { maxBytes: 1_048_576, contentTypes: ['application/pdf', 'image/png'] },
  scanner: { status: 'connected' },
  requests: [
    {
      ...base,
      id: 'ae000001-0000-4000-8000-000000000002',
      text: 'TEST a utility bill',
      dueAt: '2026-10-24T07:00:00.000Z',
      state: 'open',
      pastDue: true,
    },
    {
      ...base,
      id: 'ae000001-0000-4000-8000-000000000001',
      text: 'TEST a bank statement',
      dueAt: '2026-11-07T12:00:00.000Z',
      state: 'closed',
      pastDue: false,
      answer: {
        note: 'TEST here it is',
        file: { id: 'af000001-0000-4000-8000-000000000001', contentType: 'application/pdf', byteLength: 2048, sha256: 'b'.repeat(64) },
        answeredAt: '2026-10-24T06:30:00.000Z',
      },
      closedBy: REVIEWER,
      closedAt: '2026-10-24T06:40:00.000Z',
      closeNote: 'TEST received, thank you',
    },
  ],
};
const answer = async () => ({ ok: true as const, data: null });
const html = (resource: Parameters<typeof InformationRequestsView>[0]['resource']) => {
  const out = renderToString(<InformationRequestsView resource={resource} reload={noop} answer={answer} />);
  plain(out);
  return out;
};

describe('information requests on the Compliance page', () => {
  it('warns when a request is past due, takes an answer to an open one, and shows who closed the other', () => {
    const out = html(ready(view));
    expect(out).toContain('An information request is past its due date');
    expect(out).toContain('Past due');
    expect(out).toContain('Choose a file to send with your answer');
    expect(out).toContain('Files up to 1.0 MB. Accepted: PDF, PNG.');
    expect(out).toContain('Closed by INTAFACED reviewer 99999999');
    expect(out).toContain('TEST received, thank you');
    expect(out).toContain('File sent: 2.0 KB, passed the malware check');
    expect(out.match(/Send answer/g)).toHaveLength(1);
  });
  it('has no banner when nothing is past due, and answers by note only while no scanner is connected', () => {
    const calm = html(
      ready({
        ...view,
        scanner: { status: 'not_connected', notConnected: 'vendor.malware_scan' },
        requests: [{ ...view.requests[0]!, pastDue: false }],
      }),
    );
    expect(calm).not.toContain('past its due date');
    expect(calm).toContain('the malware check isn’t connected');
    expect(calm).not.toContain('type="file"');
    expect(html(ready({ ...view, requests: [] }))).toContain('INTAFACED hasn’t asked for anything more.');
    expect(html(failed('pay.kyb_scan_failed', 503, 'error'))).not.toContain('Send answer');
  });
});
