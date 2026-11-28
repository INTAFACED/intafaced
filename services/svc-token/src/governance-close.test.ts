import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOVERNANCE_EXECUTE_UNWIRED,
  GOVERNANCE_QUORUM_BPS_ENV,
  GOVERNANCE_QUORUM_UNSET,
  GOVERNANCE_THRESHOLD_BPS_ENV,
  decideProposalOutcome,
  executeUnwiredFor,
  readGovernanceBps,
  readGovernanceParams,
} from './governance-close.js';

const REQUIRED: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://pin:pin@127.0.0.1:9/pin',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: 'svc-token-env-pin-edge-secret-00000000001',
  INTERNAL_SERVICE_SECRET: 'svc-token-env-pin-internal-secret-000001',
};

/** svc-token's own env loader, run fresh with exactly these variables over the required ones. */
async function loadTokenEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) vi.stubEnv(key, value);
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readGovernanceBps — blank is unset, never 0-as-free', () => {
  it('missing / blank / whitespace → unset', () => {
    expect(readGovernanceBps(undefined)).toEqual({ present: false });
    expect(readGovernanceBps('')).toEqual({ present: false });
    expect(readGovernanceBps('   ')).toEqual({ present: false });
  });

  it('non-integer / out of range → unset (not invented)', () => {
    expect(readGovernanceBps('abc')).toEqual({ present: false });
    expect(readGovernanceBps('10.5')).toEqual({ present: false });
    expect(readGovernanceBps('-1')).toEqual({ present: false });
    expect(readGovernanceBps('10001')).toEqual({ present: false });
    expect(readGovernanceBps('+500')).toEqual({ present: false });
  });

  it('explicit 0 is owner-present', () => {
    expect(readGovernanceBps('0')).toEqual({ present: true, bps: 0 });
  });

  it('10000 is 100%', () => {
    expect(readGovernanceBps('10000')).toEqual({ present: true, bps: 10_000 });
  });

  it('readGovernanceParams requires both env names; one blank is unset', () => {
    expect(readGovernanceParams({})).toEqual({ quorumBps: undefined, thresholdBps: undefined });
    expect(
      readGovernanceParams({
        [GOVERNANCE_QUORUM_BPS_ENV]: '1000',
        [GOVERNANCE_THRESHOLD_BPS_ENV]: '',
      }),
    ).toEqual({ quorumBps: 1000, thresholdBps: undefined });
  });
});

describe('decideProposalOutcome — close writes passed|rejected', () => {
  const q10 = { quorumBps: 1000, thresholdBps: 5000 };

  it('writes passed when quorum and for-threshold both hold', () => {
    expect(
      decideProposalOutcome({
        forWeight: 600n,
        againstWeight: 400n,
        abstainWeight: 0n,
        eligibleStake: 1000n,
        ...q10,
      }),
    ).toBe('passed');
  });

  it('writes rejected when against wins the threshold', () => {
    expect(
      decideProposalOutcome({
        forWeight: 400n,
        againstWeight: 600n,
        abstainWeight: 0n,
        eligibleStake: 1000n,
        ...q10,
      }),
    ).toBe('rejected');
  });

  it('writes rejected when quorum fails even if every ballot is for', () => {
    expect(
      decideProposalOutcome({
        forWeight: 99n,
        againstWeight: 0n,
        abstainWeight: 0n,
        eligibleStake: 1000n,
        ...q10,
      }),
    ).toBe('rejected');
  });

  it('writes rejected when nobody voted for or against (abstain-only)', () => {
    expect(
      decideProposalOutcome({
        forWeight: 0n,
        againstWeight: 0n,
        abstainWeight: 1000n,
        eligibleStake: 1000n,
        ...q10,
      }),
    ).toBe('rejected');
  });

  it('writes rejected on an empty tally', () => {
    expect(
      decideProposalOutcome({
        forWeight: 0n,
        againstWeight: 0n,
        abstainWeight: 0n,
        eligibleStake: 1000n,
        ...q10,
      }),
    ).toBe('rejected');
  });

  it('owner 0% quorum still requires the for-threshold', () => {
    expect(
      decideProposalOutcome({
        forWeight: 1n,
        againstWeight: 0n,
        abstainWeight: 0n,
        eligibleStake: 10_000n,
        quorumBps: 0,
        thresholdBps: 5000,
      }),
    ).toBe('passed');
    expect(
      decideProposalOutcome({
        forWeight: 0n,
        againstWeight: 1n,
        abstainWeight: 0n,
        eligibleStake: 10_000n,
        quorumBps: 0,
        thresholdBps: 5000,
      }),
    ).toBe('rejected');
  });
});

describe('executeUnwiredFor — grant/listing do not move value', () => {
  it('names token.governance_execute_unwired for grant and listing', () => {
    expect(executeUnwiredFor('grant')).toBe(GOVERNANCE_EXECUTE_UNWIRED);
    expect(executeUnwiredFor('listing')).toBe(GOVERNANCE_EXECUTE_UNWIRED);
    expect(executeUnwiredFor('fee_param')).toBeNull();
    expect(executeUnwiredFor('curriculum')).toBeNull();
  });
});

/** The two keys index.ts reads from the loaded env and hands readGovernanceParams. */
function governanceEnv(env: Awaited<ReturnType<typeof loadTokenEnv>>) {
  return {
    [GOVERNANCE_QUORUM_BPS_ENV]: env.TOKEN_GOVERNANCE_QUORUM_BPS,
    [GOVERNANCE_THRESHOLD_BPS_ENV]: env.TOKEN_GOVERNANCE_THRESHOLD_BPS,
  };
}

describe('env.ts / compose — no invented quorum numbers', () => {
  const compose = readFileSync(resolve(import.meta.dirname, '../../../docker-compose.apps.yml'), 'utf8');

  it('the env loader takes both BPS keys with no numeric default; unset stays unset to the close', async () => {
    const unset = await loadTokenEnv({ [GOVERNANCE_QUORUM_BPS_ENV]: undefined, [GOVERNANCE_THRESHOLD_BPS_ENV]: undefined });
    expect(unset[GOVERNANCE_QUORUM_BPS_ENV]).toBeUndefined();
    expect(unset[GOVERNANCE_THRESHOLD_BPS_ENV]).toBeUndefined();
    // What index.ts hands the service: undefined, which the close refuses as GOVERNANCE_QUORUM_UNSET
    // (token-service.test.ts, the close with no quorum set).
    expect(readGovernanceParams(governanceEnv(unset))).toEqual({ quorumBps: undefined, thresholdBps: undefined });
    expect(GOVERNANCE_QUORUM_UNSET).toBe('token.governance_quorum_unset');

    const set = await loadTokenEnv({ [GOVERNANCE_QUORUM_BPS_ENV]: '0', [GOVERNANCE_THRESHOLD_BPS_ENV]: '5000' });
    expect(readGovernanceParams(governanceEnv(set))).toEqual({ quorumBps: 0, thresholdBps: 5000 });
  });

  it('compose passes host values through with a blank default, never a number', () => {
    expect(compose).toMatch(/TOKEN_GOVERNANCE_QUORUM_BPS:\s*\$\{TOKEN_GOVERNANCE_QUORUM_BPS:-\}/);
    expect(compose).toMatch(/TOKEN_GOVERNANCE_THRESHOLD_BPS:\s*\$\{TOKEN_GOVERNANCE_THRESHOLD_BPS:-\}/);
    expect(compose).not.toMatch(/TOKEN_GOVERNANCE_QUORUM_BPS:\s*\$\{TOKEN_GOVERNANCE_QUORUM_BPS:-\d+\}/);
    expect(compose).not.toMatch(/TOKEN_GOVERNANCE_THRESHOLD_BPS:\s*\$\{TOKEN_GOVERNANCE_THRESHOLD_BPS:-\d+\}/);
  });
});
