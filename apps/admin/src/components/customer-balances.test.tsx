import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomerBalances, EntriesPanel, OutcomeProblem } from './customer-balances';
import type { ReadOutcome } from '@/lib/ops-desk/types';

const AT = '2026-10-18T03:00:00.000Z';
const failed = (over: Partial<Extract<ReadOutcome['part'], { kind: 'failed' }>> = {}): ReadOutcome => ({
  id: 'bank.customer-balances',
  asOf: AT,
  part: {
    kind: 'failed',
    message: 'svc-bank read nothing.',
    code: 'bank.ops_audit_unavailable',
    notBuilt: false,
    forbidden: false,
    ...over,
  },
});

describe('the customer balances lookup', () => {
  it('asks for a 36-character account id before it will look, and reads nothing by itself', () => {
    const out = renderToStaticMarkup(<CustomerBalances />);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Find this customer<\/button>/);
    expect(out).toContain('36-character id');
    expect(out).toContain('changes nothing');
    expect(out).not.toContain('customer-balances-result');
  });

  it('a refusal is shown in the service’s words with its code and the time, and no figure', () => {
    const out = renderToStaticMarkup(<OutcomeProblem outcome={failed()} what="the customer’s balances" />);
    expect(out).toContain('Could not load the customer’s balances');
    expect(out).toContain('svc-bank read nothing.');
    expect(out).toContain('Code: bank.ops_audit_unavailable');
    expect(out).toContain('As of 03:00:00 UTC');
    expect(out).toContain('Nothing is shown here rather than a guess.');
  });

  it('a forbidden session is a warning, a failed read is a danger', () => {
    expect(renderToStaticMarkup(<OutcomeProblem outcome={failed({ forbidden: true })} what="x" />)).toContain('data-tone="warn"');
    expect(renderToStaticMarkup(<OutcomeProblem outcome={failed()} what="x" />)).toContain('data-tone="danger"');
  });

  it('the entries panel reads nothing until asked', () => {
    const out = renderToStaticMarkup(<EntriesPanel userId="5a3b9c10-1111-4222-8333-444455556666" assetId="USDT" />);
    expect(out).toContain('Show the USDT entries');
    expect(out).toContain('logs your account and this customer');
    expect(out).not.toContain('customer-entries-check');
  });
});
