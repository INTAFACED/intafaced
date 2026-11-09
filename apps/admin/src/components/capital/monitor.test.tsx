import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpsCapitalSnapshot } from '@intafaced/contracts/ops-capital';
import { CapitalMonitor, ScenarioResult } from './monitor';
import { thresholdProblem } from './threshold-form';

const AT = '2026-11-09T06:00:00.000Z';
const base: OpsCapitalSnapshot = {
  asOf: AT,
  period: '2026-11-09',
  ownFunds: {
    status: 'read',
    asOf: AT,
    assets: [{ assetId: 'USDT', amount: '100.5', accounts: 2 }],
    accounts: [
      { ownerType: 'house', ownerId: 'market-maker', assetId: 'USDT', kind: 'available', purpose: '', balance: '100' },
      { ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available', purpose: '', balance: '0.5' },
    ],
  },
  venues: { status: 'not_connected', code: 'ops.capital.venue_not_connected', message: 'No venue adapter reports it yet.' },
  reserves: {
    status: 'read',
    asOf: AT,
    partners: [
      { partner: 'bank', label: 'TEST partner bank', test: true, reserve: { status: 'not_known' } },
      { partner: 'card', label: 'TEST partner card', test: true, reserve: { status: 'reported', assetId: 'USDC', amount: '25000' } },
    ],
  },
  buffers: [
    { assetId: 'USDT', buffer: '100.5', threshold: { status: 'unset', code: 'ops.capital.threshold_unset' }, state: 'not_monitored' },
  ],
  alerts: [],
};

describe('CapitalMonitor (J-ops-console-24 #1)', () => {
  it('names each figure’s source, says not known for an unknown reserve, and a blank threshold is not monitored with its code', () => {
    const html = renderToStaticMarkup(<CapitalMonitor snapshot={base} />);
    expect(html).toContain('Source: the ledger (svc-ledger), house and module accounts only');
    expect(html).toContain('Ledger: 2 accounts');
    expect(html).toContain('house fees:trade');
    expect(html).toContain('data-status="not_known">not known<');
    expect(html).toContain('25000 USDC, as the partner reports');
    expect(html).toContain('svc-bank, the partner bank adapter');
    expect(html).toContain('data-not-connected="ops.capital.venue_not_connected"');
    expect(html).toContain('<strong>Not monitored</strong>');
    expect(html).toContain('<code>ops.capital.threshold_unset</code> No minimum buffer is set for this asset, so it is not monitored.');
    expect(html).not.toContain('At or above the minimum');
  });

  it('shows a venue’s balance with its as-of time beside its minimum, or not published', () => {
    const html = renderToStaticMarkup(
      <CapitalMonitor
        snapshot={{
          ...base,
          venues: {
            status: 'read',
            venues: [
              {
                venueId: 'sim',
                displayName: 'TEST venue',
                test: true,
                builderAccount: '0xb0',
                balance: { status: 'read', assetId: 'USDC', amount: '120', asOf: AT },
                minimum: { status: 'not_published' },
              },
            ],
          },
        }}
      />,
    );
    expect(html).toContain('TEST venue (TEST)');
    expect(html).toContain('120 USDC');
    expect(html).toContain('not published');
  });

  it('reads a venue it could not read as unknown, its balance, as-of and minimum, never 0 or not published', () => {
    const unknown = { status: 'unknown' as const, code: 'ops.capital.source_unavailable', message: 'TEST venue: did not answer.' };
    const html = renderToStaticMarkup(
      <CapitalMonitor
        snapshot={{
          ...base,
          venues: {
            status: 'read',
            venues: [{ venueId: 'sim', displayName: 'TEST venue', test: true, builderAccount: '0xb0', balance: unknown, minimum: unknown }],
          },
        }}
      />,
    );
    expect(html).toContain('data-state="unknown"');
    expect(html.match(/unknown \(ops\.capital\.source_unavailable\)/g)).toHaveLength(2);
    expect(html).not.toContain('not published');
    expect(html).not.toMatch(/>0 /);
  });

  it('reads a ledger it could not read as unknown, never zero, and a set threshold as unknown', () => {
    const html = renderToStaticMarkup(
      <CapitalMonitor
        snapshot={{
          ...base,
          ownFunds: { status: 'unknown', code: 'ops.capital.source_unavailable', message: 'svc-ledger: did not answer.' },
          buffers: [
            {
              assetId: 'USDT',
              buffer: null,
              threshold: {
                status: 'set',
                minimum: '150',
                contact: 'TEST on-call',
                version: 1,
                reason: 'r',
                setAt: AT,
                setBy: 'a',
                approvedBy: 'b',
              },
              state: 'unknown',
            },
          ],
        }}
      />,
    );
    expect(html).toContain('INTAFACED’s own funds: unknown');
    expect(html).toContain('svc-ledger: did not answer.');
    expect(html).toContain('data-state="unknown"');
    expect(html).not.toContain('own-funds-USDT');
  });

  it('shows a refused scenario in words with its code', () => {
    const html = renderToStaticMarkup(
      <ScenarioResult
        part={{
          kind: 'failed',
          message: 'This part could not be read.',
          code: 'ops.capital.source_unavailable',
          notBuilt: false,
          forbidden: false,
        }}
      />,
    );
    expect(html).toContain('No scenario was run');
    expect(html).toContain('<code>ops.capital.source_unavailable</code>');
  });

  it('holds a threshold form that is not a whole request', () => {
    expect(thresholdProblem('usdt', '1', 'x')).toMatch(/upper-case/);
    expect(thresholdProblem('USDT', '01', 'x')).toMatch(/plain decimal/);
    expect(thresholdProblem('USDT', '1', '')).toMatch(/contact/);
    expect(thresholdProblem('USDT', '', 'x')).toMatch(/names no contact/);
    expect(thresholdProblem('USDT', '', '')).toBeNull();
    expect(thresholdProblem('USDT', '2500.50', 'TEST on-call')).toBeNull();
  });
});
