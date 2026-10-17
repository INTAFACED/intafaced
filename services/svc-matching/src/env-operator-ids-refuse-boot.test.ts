/**
 * Unit card — svc-matching refuses to boot without two distinct operators (#4724)
 *
 * 1. Promise: MATCHING_OPERATOR_IDS must hold at least two distinct user ids.
 * 2. Break: a lost env var leaves journal-replayed markets trading with no
 *    reachable halt (every approval-gated door refuses with an empty list).
 * 3. Done bar: production env.ts loadEnv (not a forked slice) throws a FATAL
 *    message for unset, blank, one id and duplicate ids (also differing only
 *    by case/whitespace); two valid ids parse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

async function loadWith(operatorIds: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INTERNAL_SERVICE_SECRET', SECRET);
  vi.stubEnv('MATCHING_SNAPSHOT_EVERY', '500');
  vi.stubEnv('MATCHING_OPERATOR_IDS', operatorIds);
  return (await import('./env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-matching MATCHING_OPERATOR_IDS refuses boot', () => {
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['whitespace', '   '],
    ['commas only', ' , ,'],
    ['one id', 'aaaaaaaa-0000-4000-8000-00000000000a'],
    ['one id with a trailing comma', 'aaaaaaaa-0000-4000-8000-00000000000a,'],
    ['the same id twice', 'op-a,op-a'],
    ['the same id twice, different case and spacing', 'OP-A , op-a'],
  ])('%s', async (_label, value) => {
    await expect(loadWith(value)).rejects.toThrow(/FATAL: MATCHING_OPERATOR_IDS must list at least two distinct operator user ids/);
  });

  it('two distinct ids boot, whitespace trimmed', async () => {
    const env = await loadWith(' aaaaaaaa-0000-4000-8000-00000000000a ,\tbbbbbbbb-0000-4000-8000-00000000000b ');
    expect(env.MATCHING_OPERATOR_IDS).toContain('bbbbbbbb');
    const { parseOperatorIds } = await import('./action-approval-consume.js');
    expect([...parseOperatorIds(env.MATCHING_OPERATOR_IDS)]).toEqual([
      'aaaaaaaa-0000-4000-8000-00000000000a',
      'bbbbbbbb-0000-4000-8000-00000000000b',
    ]);
  });
});
