import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { parseOtcDeskLawJson, requirePublishedOtcDeskLaw, UNPUBLISHED_OTC_DESK_LAW, otcDeskLawStatusLine } from './desk-law.js';
import { OTC_DESK_LAW_RESIDUAL, OtcError } from './errors.js';

describe('parseOtcDeskLawJson', () => {
  it('empty → unpublished (refuse-closed default)', () => {
    expect(parseOtcDeskLawJson('')).toEqual(UNPUBLISHED_OTC_DESK_LAW);
    expect(parseOtcDeskLawJson(null)).toEqual(UNPUBLISHED_OTC_DESK_LAW);
    expect(parseOtcDeskLawJson('  ')).toEqual(UNPUBLISHED_OTC_DESK_LAW);
  });

  it('published false → unpublished', () => {
    expect(parseOtcDeskLawJson('{"published":false}')).toEqual(UNPUBLISHED_OTC_DESK_LAW);
  });

  it('published true with owner numbers', () => {
    const law = parseOtcDeskLawJson(
      JSON.stringify({
        published: true,
        spreadBps: 25,
        minStake: '1000',
        counterparty: 'platform',
        quoteTtlMs: 15_000,
        maxMidAgeSeconds: 120,
      }),
    );
    expect(law.published).toBe(true);
    if (law.published) {
      expect(law.spreadBps).toBe(25);
      expect(law.minStake).toBe(parseAmount('1000'));
      expect(law.counterparty).toBe('platform');
      expect(law.quoteTtlMs).toBe(15_000);
      expect(law.maxMidAgeSeconds).toBe(120);
    }
  });

  it('refuses invent — missing spreadBps', () => {
    expect(() =>
      parseOtcDeskLawJson(JSON.stringify({ published: true, minStake: '1', counterparty: 'platform', maxMidAgeSeconds: 60 })),
    ).toThrow(OtcError);
  });

  it('refuses invent — missing maxMidAgeSeconds', () => {
    expect(() =>
      parseOtcDeskLawJson(JSON.stringify({ published: true, spreadBps: 25, minStake: '1', counterparty: 'platform', quoteTtlMs: 15_000 })),
    ).toThrow(OtcError);
  });

  it('refuses invent — missing minStake', () => {
    expect(() =>
      parseOtcDeskLawJson(
        JSON.stringify({ published: true, spreadBps: 25, counterparty: 'platform', quoteTtlMs: 15_000, maxMidAgeSeconds: 60 }),
      ),
    ).toThrow(expect.objectContaining({ code: 'trade.otc_desk_law_blank' }));
  });

  it('refuses invent — missing quoteTtlMs (no invented 30000)', () => {
    try {
      parseOtcDeskLawJson(
        JSON.stringify({
          published: true,
          spreadBps: 25,
          minStake: '1',
          counterparty: 'platform',
          maxMidAgeSeconds: 60,
        }),
      );
      expect.unreachable('should refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
    }
  });

  it('refuses invent — null quoteTtlMs', () => {
    try {
      parseOtcDeskLawJson(
        JSON.stringify({
          published: true,
          spreadBps: 25,
          minStake: '1',
          counterparty: 'platform',
          quoteTtlMs: null,
          maxMidAgeSeconds: 60,
        }),
      );
      expect.unreachable('should refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
    }
  });

  it('owner may publish quoteTtlMs 30000 explicitly', () => {
    const law = parseOtcDeskLawJson(
      JSON.stringify({
        published: true,
        spreadBps: 25,
        minStake: '1000',
        counterparty: 'platform',
        quoteTtlMs: 30_000,
        maxMidAgeSeconds: 120,
      }),
    );
    expect(law.published).toBe(true);
    if (law.published) expect(law.quoteTtlMs).toBe(30_000);
  });
});

describe('requirePublishedOtcDeskLaw', () => {
  it('refuses blank with DIRECTION §8 residual', () => {
    try {
      requirePublishedOtcDeskLaw(UNPUBLISHED_OTC_DESK_LAW);
      expect.unreachable('should refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(OtcError);
      expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
      expect((err as OtcError).residual).toBe(OTC_DESK_LAW_RESIDUAL);
      expect(OTC_DESK_LAW_RESIDUAL).toContain('not available yet');
    }
  });

  it('status line names refuse-closed when unpublished', () => {
    expect(otcDeskLawStatusLine(UNPUBLISHED_OTC_DESK_LAW)).toContain('published=0');
  });

  it('status line publishes the stake floor the desk enforces, as a decimal', () => {
    const law = parseOtcDeskLawJson(
      JSON.stringify({
        published: true,
        spreadBps: 25,
        minStake: '100.5',
        counterparty: 'platform',
        quoteTtlMs: 15_000,
        maxMidAgeSeconds: 60,
      }),
    );
    expect(/(?:^| )minStake=(\S+)/.exec(otcDeskLawStatusLine(law))?.[1]).toBe('100.5');
  });
});
