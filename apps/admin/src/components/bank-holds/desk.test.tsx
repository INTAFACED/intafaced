import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HoldDesk, HoldRow } from '@/lib/bank-holds/read';
import { HoldsDesk } from './desk';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const row = (over: Partial<HoldRow> = {}): HoldRow => ({
  id: 'h1',
  sendId: '3f0c1f3e-5a77-4d52-9a1e-0c9b6b1f2a10',
  state: 'requested',
  reason: 'TEST reason',
  heldBy: 'op1',
  infoRequest: 'TEST ask',
  proof: null,
  releasedBy: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  send: { id: 's1', userId: 'u1', assetId: 'USDT', amount: '10', toCurrency: 'EUR', country: 'DE', deliveryMethod: 'bank' },
  ...over,
});
const controls = {
  payeeControls: { state: 'unset' as const, blockedCount: 0 },
  exchangeAllowance: { state: 'unset' as const, windowDays: null, exchangeCount: 0 },
  proofLimits: { state: 'unset' as const, allowedTypes: [], maxBytes: null },
};
const base: HoldDesk = { asOf: '2026-10-20T12:00:00.000Z', queue: { kind: 'ok', data: [] }, controls: { kind: 'ok', data: controls } };
const failed = { kind: 'failed' as const, message: 'svc-bank did not answer.', code: null, notBuilt: false, forbidden: false };
const html = (desk: HoldDesk, operatorId = 'op2') => renderToStaticMarkup(<HoldsDesk desk={desk} operatorId={operatorId} />);

describe('holds desk', () => {
  it('says unset settings are not set, and an empty queue is the service’s answer', () => {
    const out = html(base);
    expect(out).toContain('Not set: every send refuses');
    expect(out).toContain('Not set: a send refuses');
    expect(out).toContain('queue-empty');
    expect(out).toContain('place-hold');
  });
  it('never shows a down queue as an empty one', () => {
    const out = html({ ...base, queue: failed });
    expect(out).toContain('queue-failed');
    expect(out).not.toContain('queue-empty');
  });
  it('shows a row with its actions, and a file link only when a file exists', () => {
    const out = html({ ...base, queue: { kind: 'ok', data: [row()] } });
    expect(out).toContain('TEST reason');
    expect(out).toContain('hold-release');
    expect(out).not.toContain('hold-proof');
    const withFile = html({
      ...base,
      queue: {
        kind: 'ok',
        data: [row({ proof: { name: 'a.pdf', type: 'application/pdf', size: 5, sha256: 'x', uploadedAt: '2026-10-20T11:00:00.000Z' } })],
      },
    });
    expect(withFile).toContain('hold-proof');
  });
  it('disables release for the operator who placed the hold', () => {
    const out = html({ ...base, queue: { kind: 'ok', data: [row()] } }, 'op1');
    expect(out).toMatch(/<button[^>]*disabled[^>]*data-testid="hold-release"|<button[^>]*data-testid="hold-release"[^>]*disabled/);
    expect(out).toContain('second operator must release');
  });
  it('prints published settings from the service', () => {
    const out = html({
      ...base,
      controls: {
        kind: 'ok',
        data: {
          payeeControls: { state: 'published', blockedCount: 2 },
          exchangeAllowance: { state: 'published', windowDays: 30, exchangeCount: 3 },
          proofLimits: { state: 'published', allowedTypes: ['application/pdf'], maxBytes: 1000 },
        },
      },
    });
    expect(out).toContain('2 blocked accounts');
    expect(out).toContain('30-day rolling window');
    expect(out).toContain('application/pdf');
  });
});
