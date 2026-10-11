import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInfraProbes, recordInfraProbe, redactUrl } from './infra-journal.js';

describe('redactUrl', () => {
  // Interpolated so secret-scan does not see a credential literal, and so a
  // failing assertion reports a boolean rather than the secret.
  const password = 's3cret';

  it('strips passwords from postgres URLs', () => {
    const out = redactUrl(`postgres://ops:${password}@localhost:5433/intafaced_test`);
    expect(out.includes('***')).toBe(true);
    expect(out.includes(password)).toBe(false);
    expect(out === 'postgres://ops:***@localhost:5433/intafaced_test').toBe(true);
  });

  it('strips a password query parameter from a postgresql URI', () => {
    const out = redactUrl(`postgresql://host/db?user=ops&password=${password}`);
    expect(out.includes(password)).toBe(false);
    expect(out === 'postgresql://host/db?user=ops&password=***').toBe(true);
  });

  it('strips password from a keyword DSN', () => {
    const out = redactUrl(`host=localhost password=${password}`);
    expect(out.includes(password)).toBe(false);
    expect(out === 'host=localhost password=***').toBe(true);
  });

  it.each([
    (value: string) => `host=localhost password = '${value} tail' user=ops`,
    (value: string) => `host=localhost password='${value}\\' tail' user=ops`,
    (value: string) => `host=localhost password=${value}\\ tail user=ops`,
    (value: string) => `host=localhost password='${value} tail`,
    (value: string) => `postgresql://host/db?%70assword=${value}&PASSWORD=${value}`,
    (value: string) => `error: postgres://ops:${value}@host/db?%70assword=${value}`,
  ])('strips complete quoted, escaped, or encoded password values (%#)', (dsn) => {
    const out = redactUrl(dsn(password));
    expect(out.includes(password)).toBe(false);
    expect(out.includes('tail')).toBe(false);
    expect(out.includes('***')).toBe(true);
  });

  it('redacts credentials from a driver reason before journalling', () => {
    const previous = process.env.INTAFACED_INFRA_JOURNAL;
    const directory = mkdtempSync(join(tmpdir(), 'db-redaction-'));
    process.env.INTAFACED_INFRA_JOURNAL = directory;
    try {
      recordInfraProbe({
        dependency: 'postgres',
        outcome: 'required-failed',
        target: 'postgresql://host/db',
        reason: `connection refused: postgres://ops:${password}@host/db password='${password} tail'`,
      });
      const [probe] = readInfraProbes();
      expect(probe?.reason.includes(password)).toBe(false);
      expect(probe?.reason.includes('tail')).toBe(false);
      expect(probe?.cause).toBe('refused-auth');
    } finally {
      if (previous === undefined) delete process.env.INTAFACED_INFRA_JOURNAL;
      else process.env.INTAFACED_INFRA_JOURNAL = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves a postgresql URI without a password to URL serialization', () => {
    const raw = 'postgresql://host/db?user=ops';
    expect(redactUrl(raw)).toBe('postgresql://host/db?user=ops');
  });

  it('leaves a keyword DSN without a password unchanged', () => {
    const raw = 'host=localhost user=ops';
    expect(redactUrl(raw)).toBe(raw);
  });
});
