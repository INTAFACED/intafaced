import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseRigUser,
  readStratumTerms,
  stratumSession,
  stratumWindowEndsAt,
  stratumWindowId,
  type StratumDoorDeps,
} from './stratum-door.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const SECRET = `msk_${'A'.repeat(43)}`;
const TERMS: NodeJS.ProcessEnv = {
  MINING_STRATUM_LISTEN_PORT: '3999',
  MINING_STRATUM_WINDOW_SECONDS: '604800',
  MINING_STRATUM_ASSET_ID: 'TEST',
};

describe('miner door terms and user names', () => {
  it('reads published terms; any blank or unusable term refuses mining.stratum_unset, never a default', () => {
    expect(readStratumTerms(TERMS)).toEqual({ port: 3999, windowSeconds: 604800, assetId: 'TEST' });
    for (const env of [
      {},
      { ...TERMS, MINING_STRATUM_LISTEN_PORT: '' },
      { ...TERMS, MINING_STRATUM_LISTEN_PORT: '0' },
      { ...TERMS, MINING_STRATUM_WINDOW_SECONDS: ' ' },
      { ...TERMS, MINING_STRATUM_WINDOW_SECONDS: '59' },
      { ...TERMS, MINING_STRATUM_WINDOW_SECONDS: '2678401' },
      { ...TERMS, MINING_STRATUM_ASSET_ID: '' },
      { ...TERMS, MINING_STRATUM_ASSET_ID: 'test' },
    ]) {
      expect(() => readStratumTerms(env), JSON.stringify(env)).toThrow(expect.objectContaining({ code: 'mining.stratum_unset' }));
    }
  });

  it('names fixed windows by their length and index from the Unix epoch', () => {
    expect(stratumWindowId(60, 0)).toBe('stratum:60:0');
    expect(stratumWindowId(60, 59_999)).toBe('stratum:60:0');
    expect(stratumWindowId(60, 60_000)).toBe('stratum:60:1');
    expect(stratumWindowEndsAt('stratum:60:0')).toBe(60_000);
    expect(stratumWindowEndsAt('stratum:604800:2948')).toBe(2949 * 604800 * 1000);
    for (const other of ['LOCAL-TEST-unpaid-window', 'stratum:0:1', 'stratum:60:', 'stratum:60:1:2']) {
      expect(stratumWindowEndsAt(other), other).toBeNull();
    }
  });

  it('a user name is <account id>.<worker name> fitting the published pattern; no worker name is the default worker', () => {
    const pattern = { MINING_WORKER_NAME_PATTERN: 'TEST.{worker}' };
    expect(parseRigUser(`${ALICE}.TEST.Rig-A`, pattern)).toEqual({ minerId: ALICE, workerName: 'Rig-A' });
    expect(parseRigUser(ALICE, pattern)).toEqual({ minerId: ALICE, workerName: 'default' });
    expect(parseRigUser(`${ALICE}.Rig-A`, {})).toEqual({ minerId: ALICE, workerName: 'Rig-A' });
    // Every {worker} holds the same rig name, as the room fills them all.
    const twice = { MINING_WORKER_NAME_PATTERN: '{worker}.{worker}' };
    expect(parseRigUser(`${ALICE}.Rig-A.Rig-A`, twice)).toEqual({ minerId: ALICE, workerName: 'Rig-A' });
    expect(() => parseRigUser(`${ALICE}.Rig-A.Rig-B`, twice)).toThrow(expect.objectContaining({ code: 'mining.worker_name_invalid' }));
    for (const [raw, env, code] of [
      [`${ALICE}.Rig-A`, pattern, 'mining.worker_name_invalid'],
      [`${ALICE}.TEST.`, pattern, 'mining.worker_name_invalid'],
      [`${ALICE}.TEST.a:b`, pattern, 'mining.worker_name_invalid'],
      [`${ALICE}.`, {}, 'mining.worker_name_invalid'],
      ['not-an-account.Rig-A', {}, 'mining.account_invalid'],
      ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', {}, 'mining.account_invalid'],
      [42, {}, 'mining.account_invalid'],
    ] as const) {
      expect(() => parseRigUser(raw, env), String(raw)).toThrow(expect.objectContaining({ code }));
    }
  });
});

describe('miner door session without a database', () => {
  const session = (env: NodeJS.ProcessEnv, clock = { at: 0 }) => {
    const sent: unknown[] = [];
    // The credential read is the only query authorize makes before the job; this stands in for it with ALICE's secret.
    const hash = createHash('sha256').update(SECRET).digest('hex');
    const sql = (() => Promise.resolve([{ secret_hash: hash }])) as never;
    const deps = { sql, env, terms: readStratumTerms(TERMS), now: () => clock.at } satisfies StratumDoorDeps;
    return { sent, handle: stratumSession(deps, (line) => sent.push(JSON.parse(line))) };
  };

  it('when a window ends, renew sends each authorized rig the new window job, and nothing before it ends', async () => {
    const clock = { at: 0 };
    const { sent, handle } = session({ MINING_POW_DIMENSION: '8', MINING_POW_TARGET_BITS: '8', MINING_POW_TESTNET: 'true' }, clock);
    await handle(JSON.stringify({ id: 1, method: 'mining.authorize', params: [`${ALICE}.Rig-A`, SECRET] }));
    expect(sent).toHaveLength(2);
    clock.at = 604800 * 1000 - 1;
    handle.renew();
    expect(sent).toHaveLength(2);
    clock.at = 604800 * 1000;
    handle.renew();
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ id: null, method: 'mining.notify' });
    expect((sent[2] as { params: unknown[] }).params[0]).toBe('stratum:604800:1');
  });

  it('blank proof-of-work parameters refuse authorize with mining.pow_spec_unset and send no job', async () => {
    const { sent, handle } = session({});
    await handle(JSON.stringify({ id: 1, method: 'mining.authorize', params: [`${ALICE}.Rig-A`, SECRET] }));
    expect(sent).toEqual([{ id: 1, result: null, error: { code: 'mining.pow_spec_unset', message: expect.any(String) } }]);
  });

  it('a malformed line, an unknown method and a submit before authorize each refuse by their own code', async () => {
    const { sent, handle } = session({ MINING_POW_DIMENSION: '8', MINING_POW_TARGET_BITS: '8', MINING_POW_TESTNET: 'true' });
    await handle('not json');
    await handle(JSON.stringify({ id: 2, method: 'mining.extranonce', params: [] }));
    await handle(JSON.stringify({ id: 3, method: 'mining.submit', params: [`${ALICE}.Rig-A`, 'stratum:604800:0', '1'] }));
    expect(sent.map((reply) => (reply as { error: { code: string } }).error.code)).toEqual([
      'mining.stratum_malformed',
      'mining.stratum_method_unknown',
      'mining.stratum_unauthorized',
    ]);
  });
});
