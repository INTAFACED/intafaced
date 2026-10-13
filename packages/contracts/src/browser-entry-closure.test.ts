import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

describe('browser entry closure', () => {
  it('keeps the contracts root unsuitable and the instruments schema identical on the contracts dist alone', () => {
    const script = fileURLToPath(new URL('./browser-entry-closure.check.mjs', import.meta.url));
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: repo });
    const report = JSON.parse(stdout) as {
      ok: boolean;
      scope: string;
      note: string;
      identity: { rootImportSucceeded: boolean; rootImportIsBrowserProof: boolean; sameObject: boolean };
      unsafe: { id: string; forbidden: string[] }[];
      pure: { id: string; forbidden: string[] }[];
    };
    expect(report.ok).toBe(true);
    expect(report.scope).toBe('contracts');
    expect(report.note).toContain('not browser proof');
    expect(report.note).toContain('does not read exchange-contract');
    expect(report.identity.rootImportSucceeded).toBe(true);
    expect(report.identity.rootImportIsBrowserProof).toBe(false);
    expect(report.identity.sameObject).toBe(true);
    const contractsRoot = report.unsafe.find((graph) => graph.id === 'contracts-root-dist');
    expect(contractsRoot?.forbidden.join('\n')).toContain('node:crypto');
    expect(report.pure.find((graph) => graph.id === 'contracts-instruments-dist')?.forbidden).toEqual([]);
    expect(report.pure.find((graph) => graph.id === 'contracts-identity-dist')?.forbidden).toEqual([]);
    expect(report.pure.map((graph) => graph.id).join(' ')).not.toContain('exchange');
  }, 30_000);

  it('refuses computed import and require forms', () => {
    const script = fileURLToPath(new URL('./browser-entry-closure.negative.mjs', import.meta.url));
    const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(stdout).toContain('negative-controls-ok');
  }, 30_000);
});
