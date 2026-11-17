import { describe, expect, it, vi } from 'vitest';
import { BASE_PERKS, type RankPerks } from '@intafaced/contracts';
import type { HostRightsSource } from '../host-rights.js';
import {
  CERT_PERK_REFUSE_CODE,
  CERT_PERK_RESIDUAL,
  assertNoCertPerkMoneyAttachment,
  certPerkPlaneStatus,
  certPerkPlaneStatusLine,
  certPerkRefuseExportHeader,
  certPerkRefuseExportLine,
  certPerkResidualIsHonest,
  decideCertPerkInvent,
  isCertPerkInventRefuseClosed,
  listCertPerkInventKinds,
  refuseCertToPerkMap,
  refuseInventFeeDiscount,
  refuseInventIfcGrant,
  refuseInventPerkBalance,
  refuseInventPerkMoney,
  resolveCertPerkOutcome,
  refuseUnpricedCertPerk,
  isUnpricedCertXp,
  unpricedCertLooksLikeGrantedPerkOrMoney,
  CERT_PERK_INVENT_KINDS_PIN,
  certPerkInventKindsMatchPin,
  grantCertPerkPayoutRefuse,
  certPerkPlanePinsInventPayoutClosed,
  grantCertMustNotInventPerkPayout,
} from './perk-plane.js';

const perks = (overrides: Partial<RankPerks> = {}): RankPerks => ({ ...BASE_PERKS, ...overrides });

describe('academy.certs D26-P1-C1 perk plane — real or refuse; no fake perk money', () => {
  it('refuses every invent / cert→perk money kind closed', () => {
    for (const d of [
      refuseCertToPerkMap(),
      refuseInventPerkMoney(),
      refuseInventFeeDiscount(),
      refuseInventIfcGrant(),
      refuseInventPerkBalance(),
      decideCertPerkInvent('cert_to_perk_map'),
    ]) {
      expect(d.status).toBe('refuse');
      expect(d.code).toBe(CERT_PERK_REFUSE_CODE);
      expect(d.academyHoldsPerkMoney).toBe(false);
      expect(d.academyMapsCertToPerk).toBe(false);
      expect(isCertPerkInventRefuseClosed(d)).toBe(true);
      expect(d.message).toMatch(/refuse-closed|svc-identity/);
      expect(d.residual).toBe(CERT_PERK_RESIDUAL);
    }
  });

  it('assertNoCertPerkMoneyAttachment allows XP/grant-shaped payloads', () => {
    expect(() =>
      assertNoCertPerkMoneyAttachment({
        certId: 'foundations-v1',
        xpDelta: 100,
        alreadyGranted: false,
      }),
    ).not.toThrow();
    expect(() => assertNoCertPerkMoneyAttachment(null)).not.toThrow();
  });

  it('assertNoCertPerkMoneyAttachment throws on invent perk money fields', () => {
    expect(() => assertNoCertPerkMoneyAttachment({ perkMoney: '10.00' })).toThrow(/refuse-closed|svc-identity/);
    expect(() => assertNoCertPerkMoneyAttachment({ ifcGrant: '1' })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ certPerkMap: { a: 1 } })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ inventedFeeDiscountBps: 50 })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ perkBalance: '0' })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ perkPayout: true })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ perkPayoutAmount: '10.00' })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ inventedPerkPayout: true })).toThrow();
    expect(() => assertNoCertPerkMoneyAttachment({ certToPerkMoneyMap: { 'foundations-v1': '1' } })).toThrow();
  });

  it('resolves real perks from identity SoT — never invents a table', async () => {
    const hostRights: HostRightsSource = {
      perksOf: vi.fn(async () => perks({ lobbyHostRights: true, feeDiscountBps: 150 })),
    };
    const outcome = await resolveCertPerkOutcome({
      userId: 'u-1',
      hostRights,
      xp: { emitted: true, idempotencyKey: 'academy.cert:cert:u-1:foundations-v1', xpDelta: 100 },
    });
    expect(outcome).toEqual({
      status: 'real',
      path: 'identity_rank',
      sot: 'svc-identity',
      academyHoldsPerkMoney: false,
      academyMapsCertToPerk: false,
      perks: perks({ lobbyHostRights: true, feeDiscountBps: 150 }),
    });
  });

  it('refuses when identity is unreadable — no fake RankPerks', async () => {
    const hostRights: HostRightsSource = {
      perksOf: vi.fn(async () => {
        throw new Error('identity down');
      }),
    };
    const outcome = await resolveCertPerkOutcome({
      userId: 'u-1',
      hostRights,
      xp: { emitted: false, reason: 'publisher_unavailable' },
    });
    expect(outcome.status).toBe('refuse');
    if (outcome.status !== 'refuse') throw new Error('expected refuse');
    expect(outcome.reason).toBe('identity_unreadable');
    expect(outcome.academyHoldsPerkMoney).toBe(false);
    expect(outcome.academyMapsCertToPerk).toBe(false);
    expect(outcome).not.toHaveProperty('perks');
  });

  it('unpriced cert (no XP policy) publishes nothing — not a granted perk or perk money', async () => {
    const hostRights: HostRightsSource = {
      perksOf: vi.fn(async () => perks({ lobbyHostRights: true, feeDiscountBps: 150 })),
    };
    const xp = { emitted: false as const, reason: 'no_policy' as const };
    const outcome = await resolveCertPerkOutcome({ userId: 'u-1', hostRights, xp });
    expect(isUnpricedCertXp(xp)).toBe(true);
    expect(outcome).toEqual(refuseUnpricedCertPerk());
    expect(outcome.status).toBe('refuse');
    if (outcome.status !== 'refuse') throw new Error('expected refuse');
    expect(outcome.reason).toBe('unpriced');
    expect(outcome).not.toHaveProperty('perks');
    expect(outcome.academyHoldsPerkMoney).toBe(false);
    expect(hostRights.perksOf).not.toHaveBeenCalled();
    expect(unpricedCertLooksLikeGrantedPerkOrMoney({ xp, perks: outcome })).toBe(false);
  });

  it('fails closed when an unpriced cert still looks like a granted perk or perk money', () => {
    const xp = { emitted: false as const, reason: 'no_policy' as const };
    const lyingReal: Parameters<typeof unpricedCertLooksLikeGrantedPerkOrMoney>[0]['perks'] = {
      status: 'real',
      path: 'identity_rank',
      sot: 'svc-identity',
      academyHoldsPerkMoney: false,
      academyMapsCertToPerk: false,
      perks: perks({ feeDiscountBps: 150 }),
    };
    expect(unpricedCertLooksLikeGrantedPerkOrMoney({ xp, perks: lyingReal })).toBe(true);
    expect(
      unpricedCertLooksLikeGrantedPerkOrMoney({
        xp: { emitted: false, reason: 'no_policy', xpDelta: 100 } as never,
        perks: refuseUnpricedCertPerk(),
      }),
    ).toBe(true);
    expect(unpricedCertLooksLikeGrantedPerkOrMoney({ xp, perks: refuseUnpricedCertPerk() })).toBe(false);
  });

  it('plane status is honest — identity SoT, no academy perk money', () => {
    const plane = certPerkPlaneStatus();
    expect(plane.perksEnabledViaIdentity).toBe(true);
    expect(plane.academyMapsCertToPerk).toBe(false);
    expect(plane.academyHoldsPerkMoney).toBe(false);
    expect(plane.rankWriter).toBe('svc-identity');
    expect(certPerkResidualIsHonest(plane.residual)).toBe(true);
    expect(plane.statusLine).toBe(certPerkPlaneStatusLine());
    expect(plane.inventKindsRefuseClosed).toEqual([...listCertPerkInventKinds()]);
    expect(certPerkRefuseExportHeader()).toBe('kind,code');
    expect(certPerkRefuseExportLine(refuseInventPerkMoney())).toBe(`invent_perk_money,${CERT_PERK_REFUSE_CODE}`);
  });

  it('pins invent kinds + grant perk payout refuse so a consolation map cannot sneak in', () => {
    expect([...listCertPerkInventKinds()]).toEqual([...CERT_PERK_INVENT_KINDS_PIN]);
    expect(certPerkInventKindsMatchPin()).toBe(true);
    expect(certPerkInventKindsMatchPin(['invent_perk_money'])).toBe(false);
    const payout = grantCertPerkPayoutRefuse();
    expect(isCertPerkInventRefuseClosed(payout)).toBe(true);
    expect(payout.kind).toBe('invent_perk_money');
    expect(payout.status).toBe('refuse');
    expect(certPerkPlanePinsInventPayoutClosed()).toBe(true);
    expect(
      certPerkPlanePinsInventPayoutClosed({
        ...certPerkPlaneStatus(),
        academyHoldsPerkMoney: true as false,
      }),
    ).toBe(false);
  });

  it('unpriced grantCert view must refuse invented perk payout — publish nothing', async () => {
    const hostRights: HostRightsSource = {
      perksOf: vi.fn(async () => perks({ feeDiscountBps: 50 })),
    };
    const xp = { emitted: false as const, reason: 'no_policy' as const };
    const perksOut = await resolveCertPerkOutcome({ userId: 'u-1', hostRights, xp });
    expect(grantCertMustNotInventPerkPayout({ xp, perks: perksOut })).toBe(true);
    expect(
      grantCertMustNotInventPerkPayout({
        xp,
        perks: {
          status: 'real',
          path: 'identity_rank',
          sot: 'svc-identity',
          academyHoldsPerkMoney: false,
          academyMapsCertToPerk: false,
          perks: perks({ feeDiscountBps: 50 }),
        },
      }),
    ).toBe(false);
  });

  it('priced grant may surface identity perks but never an academy perk map', async () => {
    const hostRights: HostRightsSource = {
      perksOf: vi.fn(async () => perks()),
    };
    const xp = {
      emitted: true as const,
      idempotencyKey: 'academy.cert:cert:u-1:foundations-v1',
      xpDelta: 100,
    };
    const perksOut = await resolveCertPerkOutcome({ userId: 'u-1', hostRights, xp });
    expect(grantCertMustNotInventPerkPayout({ xp, perks: perksOut })).toBe(true);
    expect(perksOut.academyMapsCertToPerk).toBe(false);
    expect(perksOut.academyHoldsPerkMoney).toBe(false);
  });
});
