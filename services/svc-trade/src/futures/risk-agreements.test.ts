/**
 * D-account-07 — versioned risk agreements and margin terms. Hermetic: the memory store stands in for the table.
 * The wording below is TEST text; the real text is the owner's and per jurisdiction.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptAgreement,
  AGREEMENT_KIND_UNKNOWN,
  AGREEMENT_REGION_UNAVAILABLE,
  AGREEMENT_REQUIRED,
  AGREEMENT_UNPUBLISHED,
  AGREEMENT_VERSION_STALE,
  agreementTextId,
  assertAgreementsAccepted,
  memoryRiskAgreementStore,
  normalizeRegion,
  readAgreementView,
  type AgreementKind,
  type AgreementVersion,
} from './risk-agreements.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-10-20T10:00:00.000Z');
const LATER = new Date('2026-10-20T11:00:00.000Z');

function version(kind: AgreementKind, n: number, regions: string[]): AgreementVersion {
  return {
    kind,
    version: n,
    publishedAt: AT,
    texts: regions.map((region) => ({
      region,
      textId: agreementTextId(kind, n, region),
      title: `TEST ${kind} v${n} ${region}`,
      body: `TEST body ${kind} v${n} ${region}`,
      bodySha256: `sha256:test-${n}-${region}`,
    })),
  };
}

describe('risk agreements: refusals', () => {
  it('nothing published refuses trade.agreement_unpublished and never invents a version', async () => {
    const store = memoryRiskAgreementStore();
    await expect(assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk'], region: 'DE' })).rejects.toMatchObject({
      code: AGREEMENT_UNPUBLISHED,
      status: 403,
    });
    await expect(
      acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT }),
    ).rejects.toMatchObject({
      code: AGREEMENT_UNPUBLISHED,
    });
    expect(store.accepted()).toEqual([]);
  });

  it('a jurisdiction with no text refuses trade.agreement_region_unavailable (also a missing or blank region)', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    for (const region of ['FR', 'XX', '', '  ', null]) {
      await expect(assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk'], region })).rejects.toMatchObject({
        code: AGREEMENT_REGION_UNAVAILABLE,
        status: 403,
      });
    }
    await expect(
      acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'FR', now: AT }),
    ).rejects.toMatchObject({
      code: AGREEMENT_REGION_UNAVAILABLE,
    });
  });

  it('published and not accepted refuses trade.agreement_required and names the document id', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    const err = await assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk'], region: 'de' }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: AGREEMENT_REQUIRED,
      status: 403,
      detail: { kind: 'derivatives_risk', version: 1, documentId: 'derivatives_risk:v1:DE' },
    });
  });

  it('given v2 is published and the user accepted v1, the open refuses with the v2 document id; v1 stays linked', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    await expect(assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk'], region: 'DE' })).resolves.toBeUndefined();

    store.publish(version('derivatives_risk', 2, ['DE']));
    await expect(assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk'], region: 'DE' })).rejects.toMatchObject({
      code: AGREEMENT_REQUIRED,
      detail: { version: 2, documentId: 'derivatives_risk:v2:DE' },
    });
    expect(store.accepted()).toHaveLength(1);
    expect(store.accepted()[0]).toMatchObject({ version: 1, textId: 'derivatives_risk:v1:DE' });

    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 2, region: 'DE', now: LATER });
    await expect(assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk'], region: 'DE' })).resolves.toBeUndefined();
    expect(store.accepted().map((a) => a.version)).toEqual([1, 2]);
  });

  it('acceptance is per user: another account is still refused', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    await expect(assertAgreementsAccepted(store, { userId: OTHER, kinds: ['derivatives_risk'], region: 'DE' })).rejects.toMatchObject({
      code: AGREEMENT_REQUIRED,
    });
  });

  it('each required kind is checked: margin terms unaccepted refuses even when the risk agreement is accepted', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    store.publish(version('margin_terms', 1, ['DE']));
    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    await expect(
      assertAgreementsAccepted(store, { userId: USER, kinds: ['derivatives_risk', 'margin_terms'], region: 'DE' }),
    ).rejects.toMatchObject({ code: AGREEMENT_REQUIRED, detail: { kind: 'margin_terms', documentId: 'margin_terms:v1:DE' } });
  });

  it('accepting a stale version or an unknown kind refuses and records nothing', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    store.publish(version('derivatives_risk', 2, ['DE']));
    for (const stale of [1, 3, '2', null, 2.5]) {
      await expect(
        acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: stale, region: 'DE', now: AT }),
      ).rejects.toMatchObject({ code: AGREEMENT_VERSION_STALE, status: 409, detail: { currentVersion: 2 } });
    }
    await expect(acceptAgreement(store, { userId: USER, kind: 'bogus', version: 1, region: 'DE', now: AT })).rejects.toMatchObject({
      code: AGREEMENT_KIND_UNKNOWN,
      status: 400,
    });
    expect(store.accepted()).toEqual([]);
  });
});

describe('risk agreements: idempotent acceptance', () => {
  it('a repeat on (user, kind, version) keeps the first row and its time', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    const first = await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    const second = await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: LATER });
    expect(first).toMatchObject({ created: true, acceptedAt: AT.toISOString(), textId: 'derivatives_risk:v1:DE', region: 'DE' });
    expect(second).toMatchObject({ created: false, acceptedAt: AT.toISOString() });
    expect(store.accepted()).toHaveLength(1);
  });

  it('region is normalised and the text id records the jurisdiction text shown', async () => {
    expect(normalizeRegion(' de ')).toBe('DE');
    const store = memoryRiskAgreementStore();
    store.publish(version('margin_terms', 1, ['DE', 'GB']));
    const res = await acceptAgreement(store, { userId: USER, kind: 'margin_terms', version: 1, region: 'gb', now: AT });
    expect(res).toMatchObject({ region: 'GB', textId: 'margin_terms:v1:GB' });
  });
});

describe('risk agreements: customer read', () => {
  it('reads as data: unpublished and unavailable regions carry the reason, a published text carries accepted state', async () => {
    const store = memoryRiskAgreementStore();
    expect(await readAgreementView(store, USER, 'derivatives_risk', 'DE')).toMatchObject({
      available: false,
      reason: AGREEMENT_UNPUBLISHED,
    });
    store.publish(version('derivatives_risk', 1, ['DE']));
    expect(await readAgreementView(store, USER, 'derivatives_risk', 'FR')).toMatchObject({
      available: false,
      reason: AGREEMENT_REGION_UNAVAILABLE,
    });
    expect(await readAgreementView(store, USER, 'derivatives_risk', 'DE')).toMatchObject({
      available: true,
      version: 1,
      accepted: false,
      acceptedAt: null,
      textId: 'derivatives_risk:v1:DE',
    });
    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    expect(await readAgreementView(store, USER, 'derivatives_risk', 'DE')).toMatchObject({
      accepted: true,
      acceptedAt: AT.toISOString(),
    });
  });
});
