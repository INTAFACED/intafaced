import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

describe('browser entry closure', () => {
  it('serves exchange schemas without the admission-proof Node graph', () => {
    const script = fileURLToPath(new URL('./browser-entry-closure.check.mjs', import.meta.url));
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: repo });
    const report = JSON.parse(stdout) as {
      ok: boolean;
      scope: string;
      identity: { sameObject: boolean; optionsMatchTradingSchedules: boolean; rootImportIsBrowserProof: boolean };
      unsafe: { id: string; forbidden: string[] }[];
      pure: { id: string; forbidden: string[]; specifiers: string[]; unresolved: string[] }[];
    };
    expect(report.ok).toBe(true);
    expect(report.scope).toBe('exchange-contract');
    expect(report.identity.sameObject).toBe(true);
    expect(report.identity.optionsMatchTradingSchedules).toBe(true);
    expect(report.identity.rootImportIsBrowserProof).toBe(false);
    const exchangeRoot = report.unsafe.find((graph) => graph.id === 'exchange-root-dist');
    expect(exchangeRoot?.forbidden.join('\n')).toContain('node:crypto');
    expect(exchangeRoot?.forbidden.join('\n')).toContain('market-lifecycle-admission-proof.js');
    const schemas = report.pure.find((graph) => graph.id === 'exchange-schemas-dist');
    expect(schemas?.forbidden).toEqual([]);
    expect(schemas?.unresolved).toEqual([]);
    expect(schemas?.specifiers).toContain('@intafaced/contracts/instruments');
    expect(schemas?.specifiers).not.toContain('@intafaced/contracts');
    expect(report.pure.find((graph) => graph.id === 'ledger-money-source')?.forbidden).toEqual([]);
  });
});
