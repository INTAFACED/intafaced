import { describe, expect, it } from 'vitest';
import { SERVICE_RUNBOOK, serviceRecordValues } from './ops-console-services.js';

describe('service records', () => {
  it('takes a runbook inside docs/runbooks only', () => {
    for (const ok of ['docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md', 'docs/runbooks/ledger/freeze.md'])
      expect(SERVICE_RUNBOOK.test(ok)).toBe(true);
    for (const bad of [
      'https://evil.example/runbook.md',
      '/docs/runbooks/a.md',
      'docs/runbooks/../../AGENTS.md',
      'docs/runbooks/a.txt',
      'docs/adr/a.md',
      'docs/runbooks/.md',
      'docs/runbooks/a//b.md',
      'docs/runbooks/a/.md',
      `docs/runbooks/${'a'.repeat(200)}.md`,
      'javascript:alert(1)//docs/runbooks/a.md',
    ])
      expect(SERVICE_RUNBOOK.test(bad)).toBe(false);
  });

  it('trims, treats blank as unset, orders dependencies as the registry does, and names every refused field', () => {
    expect(
      serviceRecordValues('ledger', {
        ownerTeam: '  Core platform ',
        dependencies: ['edge', 'identity'],
        runbook: ' docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md ',
      }),
    ).toEqual({
      ok: true,
      values: { ownerTeam: 'Core platform', dependencies: ['identity', 'edge'], runbook: 'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md' },
    });
    expect(serviceRecordValues('ledger', { ownerTeam: ' ', dependencies: [], runbook: '' })).toEqual({
      ok: true,
      values: { ownerTeam: null, dependencies: [], runbook: null },
    });
    expect(serviceRecordValues('ledger', { ownerTeam: 'x'.repeat(81), dependencies: ['ledger'], runbook: 'https://x/y.md' })).toEqual({
      ok: false,
      invalid: ['ownerTeam', 'runbook', 'dependencies'],
    });
    expect(serviceRecordValues('ledger', { ownerTeam: null, dependencies: ['edge', 'edge'], runbook: null })).toEqual({
      ok: false,
      invalid: ['dependencies'],
    });
    expect(serviceRecordValues('ledger', { ownerTeam: null, dependencies: ['mars'], runbook: null })).toEqual({
      ok: false,
      invalid: ['dependencies'],
    });
  });
});
