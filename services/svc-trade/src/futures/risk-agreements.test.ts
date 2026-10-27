/**
 * D-account-07 — versioned risk agreements and margin terms, the data the operator publishes. No open or customer door
 * waits on an acceptance (owner decision 2026-10-27). Hermetic: the memory store stands in for the table.
 * The wording below is TEST text; the real text is the owner's and per jurisdiction.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptAgreement,
  AGREEMENT_KIND_UNKNOWN,
  AGREEMENT_REGION_UNAVAILABLE,
  AGREEMENT_UNPUBLISHED,
  AGREEMENT_VERSION_STALE,
  agreementTextId,
  memoryRiskAgreementStore,
  normalizeRegion,
  type AgreementKind,
  type AgreementVersion,
} from './risk-agreements.js';

const USER = '11111111-1111-4111-8111-111111111111';
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
      await expect(acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region, now: AT })).rejects.toMatchObject({
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

  it('given v2 is published, v1 acceptances stay linked to v1 and a v2 acceptance is its own row', async () => {
    const store = memoryRiskAgreementStore();
    store.publish(version('derivatives_risk', 1, ['DE']));
    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    store.publish(version('derivatives_risk', 2, ['DE']));
    expect(store.accepted()).toHaveLength(1);
    expect(store.accepted()[0]).toMatchObject({ version: 1, textId: 'derivatives_risk:v1:DE' });
    await acceptAgreement(store, { userId: USER, kind: 'derivatives_risk', version: 2, region: 'DE', now: LATER });
    expect(store.accepted().map((a) => a.version)).toEqual([1, 2]);
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
