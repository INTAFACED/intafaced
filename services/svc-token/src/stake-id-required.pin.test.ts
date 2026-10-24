import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('token.stake requires a caller stakeId', () => {
  it('does not mint a UUID on stake', () => {
    const service = readFileSync(join(here, 'token-service.ts'), 'utf8');
    const stake = service.slice(service.indexOf('async stake(input:'), service.indexOf('async unstake('));
    expect(stake).toMatch(/token\.stake_id_required/);
    expect(stake).not.toMatch(/crypto\.randomUUID\(\)/);
    expect(stake).not.toMatch(/stakeId \?\? /);
  });

  it('router stake input requires stakeId uuid', () => {
    const router = readFileSync(join(here, 'router.ts'), 'utf8');
    const door = router.slice(
      router.indexOf("stake: scopedProcedure('token:stake'"),
      router.indexOf("unstake: scopedProcedure('token:stake'"),
    );
    expect(door).toMatch(/stakeId: z\.string\(\)\.guid\(\)/);
    expect(door).not.toMatch(/stakeId: z\.string\(\)\.guid\(\)\.optional\(\)/);
    expect(door).toMatch(/stakeId: input\.stakeId/);
  });

  it('emission curve initialEpochReward is a decimal string, not a JSON number', () => {
    const service = readFileSync(join(here, 'token-service.ts'), 'utf8');
    const load = service.slice(service.indexOf('async emissionParams('), service.indexOf('async accessOf('));
    expect(load).toMatch(/must be a decimal string, not a JSON number/);
    expect(load).toMatch(/typeof initialRaw === 'number'/);
    expect(load).not.toMatch(/parseAmount\(String\(initialRaw\)\)/);
    expect(load).not.toMatch(/typeof initialRaw !== 'string' && typeof initialRaw !== 'number'/);
  });
});
