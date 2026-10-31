import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { QuotaRefusalOr, quotaRefusal } from './QuotaRefusal';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const failed = (message: string) => ({ ok: false as const, reason: 'error' as const, status: 412, code: 'PRECONDITION_FAILED', message });

// AL-limits-01 (J-algo-dev-03 #9): a quota refusal names the resource with its counts, never a generic refusal.
describe('quota refusals', () => {
  it('reads the resource, counts and profile from svc-quant refusals', () => {
    expect(quotaRefusal('quant.quota_exceeded — stored_runs — stored runs: 3 used of 3 allowed by profile TEST three runs')).toEqual({
      kind: 'exceeded',
      resource: 'stored_runs',
      used: '3',
      limit: '3',
      profile: 'TEST three runs',
      needs: null,
    });
    expect(
      quotaRefusal(
        'quant.quota_exceeded — storage_bytes — stored source and results (bytes): 900 used of 1000 allowed by profile TEST — this needs 200 more',
      ),
    ).toEqual({ kind: 'exceeded', resource: 'storage_bytes', used: '900', limit: '1000', profile: 'TEST', needs: '200' });
    expect(
      quotaRefusal('quant.quota_unset — concurrent_runs — the limit for runs in progress in profile ZERO is not set; nothing is assumed'),
    ).toEqual({ kind: 'limitUnset', resource: 'concurrent_runs', profile: 'ZERO' });
    expect(quotaRefusal('quant.quota_profile_unset — quota profile — this account has no quota profile')).toEqual({ kind: 'profileUnset' });
  });

  it('is not a quota refusal for another code or an unknown resource', () => {
    expect(quotaRefusal('quant.cost_unset — slippage — fill in slippage')).toBeNull();
    expect(quotaRefusal('quant.quota_exceeded — gpu_hours — gpu: 1 used of 1 allowed by profile X')).toBeNull();
  });

  it('shows the counts in words and leaves other refusals to the usual view', () => {
    const out = html(
      <QuotaRefusalOr failure={failed('quant.quota_exceeded — stored_runs — stored runs: 3 used of 3 allowed by profile TEST')} />,
    );
    expect(out).toContain('data-testid="quant-quota-refusal"');
    expect(out).toContain('Stored runs: 3 used of 3 allowed by quota profile TEST. Nothing was created.');
    expect(
      html(
        <QuotaRefusalOr
          failure={failed(
            'quant.quota_exceeded — storage_bytes — stored source and results (bytes): 900 used of 1000 allowed by profile TEST — this needs 200 more',
          )}
        />,
      ),
    ).toContain('Stored source and results (bytes): 900 used of 1000 allowed by quota profile TEST, and this needs 200 more.');
    expect(html(<QuotaRefusalOr failure={failed('quant.quota_profile_unset — quota profile — none')} />)).toContain(
      'This account has no quota profile and none is set by default',
    );
    expect(html(<QuotaRefusalOr failure={failed('quant.cost_unset — slippage — fill in slippage')} />)).not.toContain(
      'quant-quota-refusal',
    );
  });
});
