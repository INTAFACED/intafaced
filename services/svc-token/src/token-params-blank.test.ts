import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger } from '@intafaced/ledger-client';
import { TokenService } from './token-service.js';

/**
 * The migration used to insert a supply, an emission amount, a buyback split,
 * and a fee ladder, then ON CONFLICT DO NOTHING froze them. Those figures were
 * never decided. A blank column refuses the action that needs it.
 */

const migrationSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0000_token_init.sql'), 'utf8');

const USER = '11111111-1111-4111-8111-111111111111';

function blankParamsSql(row: Record<string, unknown>): Sql {
  const fn = (strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('FROM token.token_params')) return Promise.resolve([row]);
    if (q.includes('FROM token.stakes')) return Promise.resolve([]);
    throw new Error(`unexpected query: ${q}`);
  };
  return fn as unknown as Sql;
}

function service(row: Record<string, unknown>) {
  return new TokenService(blankParamsSql(row), new MemoryLedger(), new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    loadParamsFromDb: true,
    feeScheduleTtlMs: 0,
  });
}

const BLANK_ROW = {
  fee_discount_schedule: null,
  buyback_bps: null,
  burn_split_bps: null,
  total_supply: null,
  halving_interval: null,
  emission_curve: null,
};

describe('undecided token schedule stays blank', () => {
  it('does not seed live supply, emission, buyback, or fee magnitudes', () => {
    const match = /INSERT INTO "token"\."token_params"\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT \("id"\) DO NOTHING;/.exec(
      migrationSql,
    );
    expect(match, 'token_params seed INSERT missing').not.toBeNull();
    const columns = match![1]!.replace(/"/g, '').trim();
    const values = match![2]!.trim();
    expect(columns).toBe('id');
    expect(values).toBe('true');
    const seed = match![0]!;
    for (const literal of [
      '1000000000',
      '2500',
      '2000',
      '5000',
      '1460',
      'minStake',
      'initialEpochReward',
      'discountBps',
      'buyback_bps',
      'total_supply',
    ]) {
      expect(seed, `seed inserts ${literal}`).not.toContain(literal);
    }
  });

  it('refuses accessOf when the fee schedule is blank', async () => {
    const token = service(BLANK_ROW);
    await expect(token.accessOf(USER)).rejects.toMatchObject({ code: 'token.params_invalid' });
  });

  it('refuses mintEpoch when the supply is blank', async () => {
    const token = service({
      ...BLANK_ROW,
      emission_curve: { initialEpochReward: '1' },
      halving_interval: 1,
    });
    await expect(token.mintEpoch(0)).rejects.toMatchObject({ code: 'token.params_invalid' });
  });

  it('refuses buybackParams when the split is blank', async () => {
    const token = service(BLANK_ROW);
    await expect(token.buybackParams()).rejects.toMatchObject({ code: 'token.params_invalid' });
  });
});
