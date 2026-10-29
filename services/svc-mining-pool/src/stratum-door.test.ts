import { describe, expect, it } from 'vitest';
import { parseRigUser, readStratumTerms, stratumSession, stratumWindowId, type StratumDoorDeps } from './stratum-door.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
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
  });

  it('a user name is <account id>.<worker name> fitting the published pattern; no worker name is the default worker', () => {
    const pattern = { MINING_WORKER_NAME_PATTERN: 'TEST.{worker}' };
    expect(parseRigUser(`${ALICE}.TEST.Rig-A`, pattern)).toEqual({ minerId: ALICE, workerName: 'Rig-A' });
    expect(parseRigUser(ALICE, pattern)).toEqual({ minerId: ALICE, workerName: 'default' });
    expect(parseRigUser(`${ALICE}.Rig-A`, {})).toEqual({ minerId: ALICE, workerName: 'Rig-A' });
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
  const session = (env: NodeJS.ProcessEnv) => {
    const sent: unknown[] = [];
    const deps = { sql: null as never, env, terms: readStratumTerms(TERMS), now: () => 0 } satisfies StratumDoorDeps;
    return { sent, handle: stratumSession(deps, (line) => sent.push(JSON.parse(line))) };
  };

  it('blank proof-of-work parameters refuse authorize with mining.pow_spec_unset and send no job', async () => {
    const { sent, handle } = session({});
    await handle(JSON.stringify({ id: 1, method: 'mining.authorize', params: [`${ALICE}.Rig-A`] }));
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
