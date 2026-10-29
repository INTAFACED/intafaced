import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  otcDeskLawStatusLine,
  otcMinNotionalFor,
  parseOtcDeskLawJson,
  requirePublishedOtcDeskLaw,
  UNPUBLISHED_OTC_DESK_LAW,
} from './desk-law.js';
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

  it('status line publishes the desk minimum per quote asset, and "unset" when it is left out', () => {
    const base = { published: true, spreadBps: 25, minStake: '1', counterparty: 'platform', quoteTtlMs: 15_000, maxMidAgeSeconds: 60 };
    const set = parseOtcDeskLawJson(JSON.stringify({ ...base, minNotional: { usdt: '1000', EUR: '900.5' } }));
    expect(/(?:^| )minNotional=(\S+)/.exec(otcDeskLawStatusLine(set))?.[1]).toBe('EUR:900.5,USDT:1000');
    expect(/(?:^| )minNotional=(\S+)/.exec(otcDeskLawStatusLine(parseOtcDeskLawJson(JSON.stringify(base))))?.[1]).toBe('unset');
  });
});

describe('desk minimum (CB-otc-07)', () => {
  const base = { published: true, spreadBps: 25, minStake: '1', counterparty: 'platform', quoteTtlMs: 15_000, maxMidAgeSeconds: 60 };
  const published = (minNotional: unknown) => {
    const law = parseOtcDeskLawJson(JSON.stringify({ ...base, minNotional }));
    if (!law.published) throw new Error('expected published law');
    return law;
  };

  it("reads each quote asset's minimum, upper-cased; an asset left out is blank", () => {
    const law = published({ usdt: '1000' });
    expect(otcMinNotionalFor(law, 'USDT')).toBe(parseAmount('1000'));
    expect(otcMinNotionalFor(law, 'EUR')).toBeNull();
  });

  it('left out or null is blank for every asset, never a default size', () => {
    const law = parseOtcDeskLawJson(JSON.stringify(base));
    if (!law.published) throw new Error('expected published law');
    expect(otcMinNotionalFor(law, 'USDT')).toBeNull();
    expect(otcMinNotionalFor(published(null), 'USDT')).toBeNull();
  });

  it('a malformed minimum refuses at boot with trade.otc_desk_law_blank', () => {
    for (const bad of [
      '1000',
      ['1000'],
      { USDT: 1000 },
      { USDT: '' },
      { USDT: '-1' },
      { USDT: 'x' },
      { 'BTC/USDT': '1' },
      { usdt: '1', USDT: '2' },
    ]) {
      try {
        published(bad);
        expect.unreachable(`should refuse ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OtcError);
        expect((err as OtcError).code).toBe('trade.otc_desk_law_blank');
      }
    }
  });
});
