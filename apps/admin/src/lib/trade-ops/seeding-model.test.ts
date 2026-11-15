import { describe, expect, it } from 'vitest';
import { checkSeedConfig, firstUnset, MM_SEED_UNSET, parseSeedConfigs, seedConfigPayloadHash, type SeedConfigDraft } from './seeding-model';

const FULL: SeedConfigDraft = {
  enabled: true,
  halfSpreadBps: '500',
  stepBps: '50',
  levels: '3',
  qtyPerLevel: '0.001',
  midSource: 'configured',
  configuredMid: '1',
};

describe('seeding configuration in the console (J-cex-spot-20 #5)', () => {
  it('refuses a blank value by name with svc-trade’s own code', () => {
    expect(checkSeedConfig({ ...FULL, stepBps: '' })).toEqual({ ok: false, code: MM_SEED_UNSET, message: expect.stringContaining('step') });
    expect(firstUnset({ ...FULL, midSource: null })).toBe('mid source');
    expect(checkSeedConfig({ ...FULL, enabled: false, stepBps: null }).ok).toBe(true);
    expect(checkSeedConfig({ ...FULL, levels: '0' })).toMatchObject({ ok: false, code: 'mm.seed_invalid' });
  });
  it('binds the approval to the same hash svc-trade computes', () => {
    const check = checkSeedConfig({ ...FULL, stepBps: ' 50 ' });
    if (!check.ok) throw new Error('expected a complete configuration');
    expect(seedConfigPayloadHash({ market: '0b6c3d0e-9f1a-4c2b-8d3e-112233445566', expectedVersion: '2', config: check.config })).toBe(
      'sha256:c31b4d9550060f541040ee772f25f8fc0752b15c7b691177484ed413475356e6',
    );
  });
  it('reads configurations, and nothing of another shape', () => {
    const row = {
      ...FULL,
      market: 'm',
      symbol: 'IFC/USDC',
      version: '1',
      operatorId: 'a',
      approverId: 'b',
      approvalId: 'x',
      writtenAt: 't',
    };
    expect(parseSeedConfigs({ configs: [row] })).toEqual([row]);
    expect(parseSeedConfigs({ configs: [{ ...row, midSource: 'other' }] })).toBeNull();
    expect(parseSeedConfigs({})).toBeNull();
  });
});
