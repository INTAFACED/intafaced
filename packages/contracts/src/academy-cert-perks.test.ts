import { createRequire } from 'node:module';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { BASE_PERKS, type IdentityContract } from './identity.js';
import {
  CERT_PERK_BANNED_PAYLOAD_KEYS,
  CERT_PERK_LAW,
  CERT_PERK_REFUSE_CODE,
  CERT_PERK_RESIDUAL,
  IDENTITY_FORBIDDEN_CERT_PERK_DOORS,
  assertNoCertPerkMoneyAttachment,
  certPerkFromIdentityRead,
  certPerkInventRefuseSchema,
  certPerkLaw,
  certPerkOutcomeSchema,
  certPerkPlaneStatus,
  certPerkPlaneStatusLine,
  certPerkRealSchema,
  certPerkRefuseExportHeader,
  certPerkRefuseExportLine,
  certPerkResidualIsHonest,
  decideCertPerkInvent,
  identitySurfaceLooksLikeCertPerkMap,
  isCertPerkInventRefuseClosed,
  listCertPerkInventKinds,
  refuseCertToPerkMap,
  refuseIdentityUnreadable,
  refuseInventFeeDiscount,
  refuseInventIfcGrant,
  refuseInventPerkBalance,
  refuseInventPerkMoney,
  refuseUnpricedCertPerk,
  type CertPerkIdentityDoors,
} from './academy-cert-perks.js';
import * as certPerkModule from './academy-cert-perks.js';

describe('academy cert → identity perk law — refuse-closed, no invent amounts', () => {
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
      expect(certPerkInventRefuseSchema.safeParse(d).success).toBe(true);
      expect(d.message).toMatch(/refuse-closed|svc-identity/);
      expect(d.residual).toBe(CERT_PERK_RESIDUAL);
      expect(d).not.toHaveProperty('perks');
      expect(d).not.toHaveProperty('perkAmount');
      expect(d).not.toHaveProperty('feeDiscountBps');
    }
    expect(listCertPerkInventKinds()).toEqual([...CERT_PERK_LAW.inventKindsRefuseClosed]);
  });

  it('assertNoCertPerkMoneyAttachment allows XP/grant-shaped payloads', () => {
    expect(() =>
      assertNoCertPerkMoneyAttachment({
        certId: 'foundations-v1',
        alreadyGranted: false,
      }),
    ).not.toThrow();
    expect(() => assertNoCertPerkMoneyAttachment(null)).not.toThrow();
  });

  it('assertNoCertPerkMoneyAttachment throws on every banned invent field', () => {
    for (const key of CERT_PERK_BANNED_PAYLOAD_KEYS) {
      expect(() => assertNoCertPerkMoneyAttachment({ [key]: true }), key).toThrow(/refuse-closed|svc-identity/);
    }
  });

  it('real path is identity rank SoT — pass-through of rank.perks, never a cert map', () => {
    const outcome = certPerkFromIdentityRead({ ok: true, perks: BASE_PERKS });
    expect(certPerkRealSchema.safeParse(outcome).success).toBe(true);
    expect(certPerkOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(outcome).toEqual({
      status: 'real',
      path: 'identity_rank',
      sot: 'svc-identity',
      academyHoldsPerkMoney: false,
      academyMapsCertToPerk: false,
      perks: BASE_PERKS,
    });
  });

  it('refuses when identity is unreadable — no fake RankPerks', () => {
    const outcome = certPerkFromIdentityRead({ ok: false, reason: 'identity_unreadable' });
    expect(outcome).toEqual(refuseIdentityUnreadable());
    expect(outcome.status).toBe('refuse');
    if (outcome.status !== 'refuse') throw new Error('expected refuse');
    expect(outcome.reason).toBe('identity_unreadable');
    expect(outcome.academyHoldsPerkMoney).toBe(false);
    expect(outcome.academyMapsCertToPerk).toBe(false);
    expect(outcome).not.toHaveProperty('perks');
    expect(certPerkOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('unpriced cert publishes nothing — not a granted perk or perk money', () => {
    const outcome = certPerkFromIdentityRead({ ok: false, reason: 'unpriced' });
    expect(outcome).toEqual(refuseUnpricedCertPerk());
    expect(outcome.status).toBe('refuse');
    if (outcome.status !== 'refuse') throw new Error('expected refuse');
    expect(outcome.reason).toBe('unpriced');
    expect(outcome).not.toHaveProperty('perks');
    expect(outcome.academyHoldsPerkMoney).toBe(false);
    expect(certPerkOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it('law board is honest — identity SoT, no academy perk book, no cert→perk map', () => {
    const law = certPerkLaw();
    expect(law.sot).toBe('svc-identity');
    expect(law.perkRead).toBe('rank.perks');
    expect(law.certWrite).toBe('rank.awardXp');
    expect(law.academyMapsCertToPerk).toBe(false);
    expect(law.academyHoldsPerkMoney).toBe(false);
    expect(law.identityAcceptsCertToPerkMap).toBe(false);
    const plane = certPerkPlaneStatus();
    expect(plane.perksEnabledViaIdentity).toBe(true);
    expect(plane.academyMapsCertToPerk).toBe(false);
    expect(plane.academyHoldsPerkMoney).toBe(false);
    expect(plane.rankWriter).toBe('svc-identity');
    expect(certPerkResidualIsHonest(plane.residual)).toBe(true);
    expect(plane.statusLine).toBe(certPerkPlaneStatusLine());
    expect(certPerkRefuseExportHeader()).toBe('kind,code');
    expect(certPerkRefuseExportLine(refuseInventPerkMoney())).toBe(`invent_perk_money,${CERT_PERK_REFUSE_CODE}`);
  });

  it('IdentityContract has no cert→perk door — only rank.awardXp + rank.perks', () => {
    const stub: IdentityContract = {
      rank: {
        get: async () => {
          throw new Error('unused');
        },
        perks: async () => BASE_PERKS,
        awardXp: async () => {
          throw new Error('unused');
        },
      },
      me: async () => {
        throw new Error('unused');
      },
    };
    expect(identitySurfaceLooksLikeCertPerkMap(stub)).toBe(false);
    expect(identitySurfaceLooksLikeCertPerkMap(stub.rank)).toBe(false);
    expect(typeof stub.rank.perks).toBe('function');
    expect(typeof stub.rank.awardXp).toBe('function');
    for (const key of IDENTITY_FORBIDDEN_CERT_PERK_DOORS) {
      expect(key in stub).toBe(false);
      expect(key in stub.rank).toBe(false);
    }
    expect(
      identitySurfaceLooksLikeCertPerkMap({
        certPerk: () => undefined,
      }),
    ).toBe(true);
  });

  it('real schema refuses an invented cert→perk map shaped as RankPerks extras', () => {
    const forged = {
      status: 'real',
      path: 'identity_rank',
      sot: 'svc-identity',
      academyHoldsPerkMoney: false,
      academyMapsCertToPerk: false,
      perks: BASE_PERKS,
      certPerkMap: { 'foundations-v1': BASE_PERKS },
    };
    // Extra keys are stripped by zod object (strip), but the law helper still flags the map door.
    expect(identitySurfaceLooksLikeCertPerkMap(forged)).toBe(true);
    expect(() => assertNoCertPerkMoneyAttachment(forged)).toThrow();
  });
});

/** Every value the module exports, and what each zero-argument function returns when called. */
function exportedSurface(mod: Record<string, unknown>): unknown[] {
  return Object.values(mod).flatMap((value) => (typeof value === 'function' && value.length === 0 ? [value, value()] : [value]));
}

/** Walks plain data (skipping zod schemas, which carry their own limits) and yields each key and leaf. */
function* walk(value: unknown, seen = new Set<unknown>()): Generator<{ key: string | null; leaf: unknown }> {
  if (value instanceof z.ZodType || seen.has(value)) return;
  if (value !== null && typeof value === 'object') {
    seen.add(value);
    for (const [key, inner] of Object.entries(value)) {
      yield { key, leaf: inner };
      yield* walk(inner, seen);
    }
    return;
  }
  yield { key: null, leaf: value };
}

describe('academy cert perk law — no ledger, no invented amounts', () => {
  it('the contracts package cannot reach a ledger client', () => {
    const require = createRequire(import.meta.url);
    const manifest = require('../package.json') as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(manifest[field] ?? {}), `contracts ${field} must not name the ledger client`).not.toContain(
        '@intafaced/ledger-client',
      );
    }
    expect(Object.keys(certPerkModule)).not.toContain('createLedgerClient');
  });

  it('loading the law and calling every door reads no ledger environment', async () => {
    const touched = new Set<string>();
    const real = process.env;
    process.env = new Proxy(real, {
      get(target, key) {
        if (typeof key === 'string') touched.add(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        if (typeof key === 'string') touched.add(key);
        return Reflect.has(target, key);
      },
    });
    try {
      vi.resetModules();
      exportedSurface(await import('./academy-cert-perks.js'));
    } finally {
      process.env = real;
    }
    expect([...touched].filter((key) => /LEDGER/.test(key))).toEqual([]);
  });

  it('nothing it exports or answers seeds a perk amount, a cert→perk map or a payout', () => {
    expect(Object.keys(certPerkModule)).not.toContain('CERT_TO_PERK_MAP');
    const forbiddenKeys = new Set(['perkAmount', 'ifcGrant', 'perkPayout', 'CERT_TO_PERK_MAP']);
    const amountKeys = new Set(['feeDiscountBps', 'xpDelta']);
    const seenKeys = new Set<string>();
    for (const { key, leaf } of walk(exportedSurface(certPerkModule))) {
      if (key !== null) seenKeys.add(key);
      if (key !== null) expect(forbiddenKeys.has(key), `invented field ${key}`).toBe(false);
      if (key !== null && amountKeys.has(key)) expect(typeof leaf, `invented amount ${key}`).not.toBe('number');
      expect(typeof leaf === 'number' || typeof leaf === 'bigint', `the law carries an amount: ${String(leaf)}`).toBe(false);
    }
    // The walk reached the law's own answers (otherwise the checks above are vacuous).
    expect([...seenKeys]).toEqual(expect.arrayContaining(['academyHoldsPerkMoney', 'residual', 'inventKindsRefuseClosed']));
  });

  it('says it is refuse-closed, reads perks from svc-identity, and holds no perk money', () => {
    expect(CERT_PERK_RESIDUAL).toMatch(/refuse-closed/);
    expect(CERT_PERK_RESIDUAL).toMatch(/svc-identity/);
    expect(CERT_PERK_LAW.sot).toBe('svc-identity');
    expect(CERT_PERK_LAW.academyHoldsPerkMoney).toBe(false);
    expect(certPerkPlaneStatus().academyHoldsPerkMoney).toBe(false);
  });

  it('its identity doors are IdentityContract rank.awardXp and rank.perks, nothing else', () => {
    expectTypeOf<keyof CertPerkIdentityDoors>().toEqualTypeOf<'awardXp' | 'perks'>();
    expectTypeOf<CertPerkIdentityDoors['awardXp']>().toEqualTypeOf<IdentityContract['rank']['awardXp']>();
    expectTypeOf<CertPerkIdentityDoors['perks']>().toEqualTypeOf<IdentityContract['rank']['perks']>();
  });
});
