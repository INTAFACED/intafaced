import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@intafaced/contracts';
import { defineRefusals } from '../refusals.js';
import { edgeCallers, expectRefusal, refusalCodeOf, serviceMigrations, TEST_USER } from './index.js';

function fakeService(): string {
  const root = mkdtempSync(join(tmpdir(), 'service-kit-'));
  writeFileSync(join(root, 'package.json'), '{}');
  mkdirSync(join(root, 'drizzle'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, 'drizzle', '20261027000002_b.sql'), 'B');
  writeFileSync(join(root, 'drizzle', '0001_a.sql'), 'A');
  writeFileSync(join(root, 'drizzle', '0001_a.down.sql'), 'DOWN');
  writeFileSync(join(root, 'drizzle', 'meta.json'), '{}');
  return root;
}

describe('serviceMigrations', () => {
  it("reads the service's up migrations in name order from a test file's url, skipping reversals", () => {
    const root = fakeService();
    expect(serviceMigrations(pathToFileURL(join(root, 'src', 'deep', 'x.db.test.ts')).href)).toEqual(['A', 'B']);
  });

  it('says where it looked when there is no drizzle folder', () => {
    expect(() => serviceMigrations(join(tmpdir(), 'nowhere', 'x.test.ts'))).toThrow(/no drizzle\/ folder/);
  });
});

describe('edgeCallers', () => {
  const callers = edgeCallers({ serviceName: 'svc-kit-test', scopes: ['kit:read'] });

  it('signs a principal the service context accepts, with the default scopes', () => {
    const ctx = callers.signed();
    expect(ctx.principal).toMatchObject({ userId: TEST_USER, scopes: ['kit:read'] });
    expect(ctx.region).toBe('DE');
  });

  it('takes overrides for one caller', () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect(callers.signed({ userId: other, sub: other, scopes: [] }).principal).toMatchObject({ userId: other, scopes: [] });
  });

  it('gives anonymous and forged callers no principal', () => {
    expect(callers.anonymous().principal).toBeNull();
    expect(callers.forged().principal).toBeNull();
  });
});

describe('expectRefusal', () => {
  const r = defineRefusals('E', { 'x.gone': 'NOT_FOUND' });

  it('passes on the service refusal and on the TRPCError that carries it', async () => {
    await expectRefusal(Promise.reject(new r.Error('x.gone')), 'x.gone');
    await expectRefusal(() => r.guard(() => r.refuse('x.gone')), 'x.gone', 'NOT_FOUND');
  });

  it('fails when the call succeeds or refuses with another code', async () => {
    await expect(expectRefusal(Promise.resolve(1), 'x.gone')).rejects.toThrow(/succeeded/);
    await expect(expectRefusal(Promise.reject(new Error('boom')), 'x.gone')).rejects.toThrow();
  });

  it('reads the code from a cause first', () => {
    expect(refusalCodeOf(new TRPCError({ code: 'NOT_FOUND', cause: new r.Error('x.gone') }))).toBe('x.gone');
    expect(refusalCodeOf('nothing')).toBeUndefined();
  });
});
