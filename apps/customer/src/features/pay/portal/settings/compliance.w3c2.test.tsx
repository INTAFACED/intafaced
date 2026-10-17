import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { ComplianceView } from './Compliance';
import { parsePortalRoute } from '../routes';
const noop = () => {};
const history = {
  status: 'ready' as const,
  items: [
    {
      seq: '1',
      fromStatus: 'pending',
      toStatus: 'approved',
      kybRef: 'TEST',
      decidedBy: 'intafaced' as const,
      reason: 'INTERNAL NOTE MUST NOT DISPLAY',
      at: '2026-10-16T00:00:00Z',
    },
  ],
  hasMore: true,
  more: 'idle' as const,
};
it('routes compliance and rejects a made-up child path', () => {
  expect(parsePortalRoute('/pay/compliance')).toEqual({ room: 'compliance' });
  expect(parsePortalRoute('/pay/compliance/foreign')).toBeNull();
});
it('keeps approved verification separate from screening clearance and hides internal notes', () => {
  const out = renderToString(
    <ComplianceView
      current={{ status: 'ready', data: { kybStatus: 'approved', kybRef: 'TEST-reference', mode: 'gateway' } }}
      history={history}
      loadMore={noop}
      reload={noop}
    />,
  );
  expect(out).toContain('Approved');
  expect(out).toContain('is not a screening clearance');
  expect(out).toContain('TEST-reference');
  expect(out).toContain('Changed by INTAFACED');
  expect(out).not.toContain('INTERNAL NOTE');
  expect(out).toContain('Load more');
});
it('shows a useful empty history and loading without fabricated clearance', () => {
  const out = renderToString(
    <ComplianceView current={{ status: 'loading' }} history={{ ...history, items: [], hasMore: false }} loadMore={noop} reload={noop} />,
  );
  expect(out).toContain('aria-busy="true"');
  expect(out).toContain('No verification history yet');
  expect(out).toContain('/pay/onboarding/verification');
});
