import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IdentityKeysDeskView } from './identity-keys-desk';
import type { KeysDeskView } from '@/lib/identity-ops/keys-browser';

const ok = (over: Partial<{ activeKeyId: string; previousKeyIds: string[]; availableKeyIds: string[] }> = {}): KeysDeskView => ({
  asOf: '2026-10-20T10:00:00.000Z',
  state: {
    kind: 'ok',
    data: { activeKeyId: 'legacy', previousKeyIds: [], activatedAt: null, availableKeyIds: ['legacy', 'k2'], ...over },
  },
});
const render = (view: KeysDeskView | null) =>
  renderToStaticMarkup(<IdentityKeysDeskView view={view} loading={false} userId="u1" onRefresh={() => undefined} />);

describe('identity keys desk', () => {
  it('shows the signing key, the read time and a rotation form for an id the host holds', () => {
    const html = render(ok());
    expect(html).toContain('legacy');
    expect(html).toContain('10:00:00 UTC');
    expect(html).toContain('Rotate the signing key to k2');
    expect(html).toContain('ROTATE KEY k2');
  });

  it('says why rotation is off when the host has no other key, and why removal is off with no previous key', () => {
    const html = render(ok({ availableKeyIds: ['legacy'] }));
    expect(html).toContain('nothing to rotate to');
    expect(html).toContain('disabled');
  });

  it('lists the previous keys still verifying', () => {
    const html = render(ok({ activeKeyId: 'k2', previousKeyIds: ['legacy'], availableKeyIds: ['legacy', 'k2'] }));
    expect(html).toContain('data-testid="keys-previous"');
    expect(html).toContain('legacy');
  });

  it('a failed read says why and offers no form; no read at all shows no state', () => {
    const failed = render({
      asOf: '2026-10-20T10:00:00.000Z',
      state: { kind: 'failed', message: 'svc-identity did not answer.', code: null, notBuilt: false, forbidden: false },
    });
    expect(failed).toContain('svc-identity did not answer.');
    expect(failed).not.toContain('request-form');
    expect(render(null)).toContain('could not be read');
  });
});
