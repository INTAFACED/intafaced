import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InstrumentError } from './instruments.js';
import { InstrumentService, assertAccessLogLimit } from './instrument-service.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * instruments.accessLog page size is refuse-closed when unset.
 *
 * accessLogFor used `limit = 100`, so omit invented a 100-row access log page.
 * Blank must refuse. Owner/client may pass 100 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('instruments.accessLog limit unset refuse', () => {
  it('assertAccessLogLimit refuses blank / NaN / 0 — never invents 100', () => {
    expect(() => assertAccessLogLimit(undefined)).toThrow(InstrumentError);
    expect(() => assertAccessLogLimit(Number.NaN)).toThrow(InstrumentError);
    expect(() => assertAccessLogLimit(0)).toThrow(InstrumentError);
    try {
      assertAccessLogLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(InstrumentError);
      expect((e as InstrumentError).code).toBe('p2p.access_log_limit_unset');
      expect((e as InstrumentError).message).toBe(resolveP2pCopy(P2P_COPY.accessLogLimitUnset));
      expect((e as InstrumentError).message).not.toMatch(/100-row|default 100/i);
    }
  });

  it('accessLogFor refuses without limit — never invents 100', async () => {
    const instruments = new InstrumentService({} as never);
    await expect(instruments.accessLogFor('owner')).rejects.toMatchObject({
      code: 'p2p.access_log_limit_unset',
    });
    expect(assertAccessLogLimit(100)).toBe(100);
  });

  it('accepts owner-published 100 and caps at 500', () => {
    expect(assertAccessLogLimit(100)).toBe(100);
    expect(assertAccessLogLimit(1)).toBe(1);
    expect(assertAccessLogLimit(500)).toBe(500);
    expect(assertAccessLogLimit(501)).toBe(500);
  });

  it('accessLogFor no longer defaults limit to 100', () => {
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/instrument-service.ts'), 'utf8');
    const start = src.indexOf('async accessLogFor(');
    const end = src.indexOf('// ── Attaching a destination to a trade', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertAccessLogLimit');
    expect(fn).not.toMatch(/limit = 100/);
    expect(fn).not.toMatch(/\?\? 100/);
  });
});
