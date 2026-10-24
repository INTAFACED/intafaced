import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { AcademyError } from '../errors.js';
import { assertVideoEntitled, videoGateNeedsStake, type VideoCaller } from './entitlement.js';

const USER = '11111111-1111-4111-8111-111111111111';

function caller(tier: string): VideoCaller {
  return { userId: USER, tier: tier as VideoCaller['tier'] };
}

function refuse(run: () => void): void {
  try {
    run();
    throw new Error('expected refuse');
  } catch (err) {
    expect(err).toBeInstanceOf(AcademyError);
    expect((err as AcademyError).code).toBe('academy.video_grant_required');
  }
}

describe('assertVideoEntitled', () => {
  it('refuses a caller tier of constructor when the published min tier is a known rung and the stake meets the threshold', () => {
    const stake = parseAmount('1');
    expect(typeof stake).toBe('bigint');
    for (const minTier of ['none', 'basic', 'full', 'institutional'] as const) {
      refuse(() =>
        assertVideoEntitled({
          gate: { minTier, minStake: '1' },
          caller: caller('constructor'),
          stake,
        }),
      );
    }
  });

  it('refuses a caller below the published min tier', () => {
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: 'basic', minStake: '0' },
        caller: caller('none'),
        stake: parseAmount('1'),
      }),
    );
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: 'full', minStake: '0' },
        caller: caller('basic'),
        stake: parseAmount('1'),
      }),
    );
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: 'institutional', minStake: '0' },
        caller: caller('full'),
        stake: parseAmount('1'),
      }),
    );
  });

  it('passes a caller at or above the published min tier when the stake meets the threshold', () => {
    const stake = parseAmount('1');
    expect(typeof stake).toBe('bigint');
    expect(() =>
      assertVideoEntitled({
        gate: { minTier: 'none', minStake: '1' },
        caller: caller('none'),
        stake,
      }),
    ).not.toThrow();
    expect(() =>
      assertVideoEntitled({
        gate: { minTier: 'basic', minStake: '1' },
        caller: caller('basic'),
        stake,
      }),
    ).not.toThrow();
    expect(() =>
      assertVideoEntitled({
        gate: { minTier: 'full', minStake: '1' },
        caller: caller('institutional'),
        stake,
      }),
    ).not.toThrow();
  });

  it('refuses a stake below the published threshold', () => {
    const stake = parseAmount('1');
    expect(typeof stake).toBe('bigint');
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: 'none', minStake: '2' },
        caller: caller('institutional'),
        stake,
      }),
    );
  });

  it('refuses a blank min tier and a blank min stake', () => {
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: '', minStake: '1' },
        caller: caller('institutional'),
        stake: parseAmount('1'),
      }),
    );
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: '   ', minStake: '1' },
        caller: caller('institutional'),
        stake: parseAmount('1'),
      }),
    );
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: 'none', minStake: '' },
        caller: caller('none'),
        stake: parseAmount('1'),
      }),
    );
    refuse(() =>
      assertVideoEntitled({
        gate: { minTier: 'none', minStake: '   ' },
        caller: caller('none'),
        stake: parseAmount('1'),
      }),
    );
  });
});

describe('videoGateNeedsStake (AC-videos-01)', () => {
  it('reads the stake only when a published minimum above zero could refuse it', () => {
    expect(videoGateNeedsStake({ minTier: 'basic', minStake: '10' })).toBe(true);
    expect(videoGateNeedsStake({ minTier: 'none', minStake: '0' })).toBe(false);
    expect(videoGateNeedsStake({ minTier: 'none', minStake: '0.000' })).toBe(false);
    // Unpublished or unparseable: the gate refuses by itself, so the stake source is not asked.
    expect(videoGateNeedsStake({ minTier: '', minStake: '' })).toBe(false);
    expect(videoGateNeedsStake({ minTier: 'basic', minStake: 'lots' })).toBe(false);
  });
});
