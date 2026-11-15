import { describe, expect, it } from 'vitest';
import {
  completeConfig,
  firstUnset,
  MM_SEED_UNSET,
  normaliseSeedConfig,
  seedConfigApprovalBody,
  type SeedConfigInput,
} from './seed-config.js';
import { payloadHash } from './common.js';

const FULL: SeedConfigInput = {
  enabled: true,
  halfSpreadBps: '500',
  stepBps: '50',
  levels: '3',
  qtyPerLevel: '0.001',
  midSource: 'configured',
  configuredMid: '1',
};

describe('seed configuration values (J-cex-spot-20 #5)', () => {
  it('names the first blank of an enabled configuration, and refuses it with mm.seed_unset', () => {
    expect(firstUnset(FULL)).toBeNull();
    expect(firstUnset({ ...FULL, stepBps: '' })).toBe('step');
    expect(firstUnset({ ...FULL, qtyPerLevel: null })).toBe('quantity per level');
    expect(firstUnset({ ...FULL, midSource: null })).toBe('mid source');
    expect(firstUnset({ ...FULL, configuredMid: ' ' })).toBe('configured mid');
    expect(firstUnset({ ...FULL, midSource: 'venue', configuredMid: null })).toBeNull();
    expect(() => normaliseSeedConfig({ ...FULL, stepBps: '' })).toThrow(
      expect.objectContaining({ code: MM_SEED_UNSET, message: expect.stringContaining('step') }),
    );
  });

  it('switching off needs no values', () => {
    const off = {
      enabled: false,
      halfSpreadBps: null,
      stepBps: null,
      levels: null,
      qtyPerLevel: null,
      midSource: null,
      configuredMid: null,
    };
    expect(normaliseSeedConfig(off)).toEqual(off);
  });

  it('refuses malformed values by name; never rounds', () => {
    expect(() => normaliseSeedConfig({ ...FULL, stepBps: '0' })).toThrow(/step/);
    expect(() => normaliseSeedConfig({ ...FULL, levels: '21' })).toThrow(/levels/);
    expect(() => normaliseSeedConfig({ ...FULL, qtyPerLevel: '0.0' })).toThrow(/quantity/);
    expect(() => normaliseSeedConfig({ ...FULL, configuredMid: '-1' })).toThrow(/configured mid/);
    expect(() => normaliseSeedConfig({ ...FULL, halfSpreadBps: '1.5' })).toThrow(/half spread/);
  });

  it('a venue mid stores no configured mid; values are trimmed before they are bound', () => {
    expect(normaliseSeedConfig({ ...FULL, midSource: 'venue', configuredMid: '7' }).configuredMid).toBeNull();
    expect(normaliseSeedConfig({ ...FULL, stepBps: ' 50 ' }).stepBps).toBe('50');
  });

  it('a stored row with a blank is not complete, whether or not it is on', () => {
    expect(completeConfig({ ...FULL, enabled: false, levels: null })).toEqual({ ok: false, unset: 'levels' });
    expect(completeConfig(FULL)).toEqual({
      ok: true,
      config: { halfSpreadBps: 500, stepBps: 50, levels: 3, qtyPerLevel: '0.001', midSource: 'configured', configuredMid: '1' },
    });
  });

  it('the approval is bound to every value: changing one changes the hash', () => {
    const a = payloadHash(seedConfigApprovalBody('m', '2', FULL));
    expect(payloadHash(seedConfigApprovalBody('m', '2', { ...FULL, levels: '4' }))).not.toBe(a);
    expect(payloadHash(seedConfigApprovalBody('m', '3', FULL))).not.toBe(a);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The console hashes the same body to the same string (apps/admin seeding-model.test.ts pins this value too).
    expect(payloadHash(seedConfigApprovalBody('0b6c3d0e-9f1a-4c2b-8d3e-112233445566', '2', normaliseSeedConfig(FULL)))).toBe(
      'sha256:c31b4d9550060f541040ee772f25f8fc0752b15c7b691177484ed413475356e6',
    );
  });
});
