import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARD_DIMENSIONS, type BlueprintProfile } from '@intafaced/contracts';
import { composeCard, type CardSubject } from '../card/compose.js';
import {
  ATTESTATION_ON_CHAIN_UNBUILT,
  ATTESTATION_PII_CROSS_PLANE_ADDRESS,
  ATTESTATION_PII_CUSTODIAL_USER_ID,
  ATTESTATION_PII_IDENTITY,
  ATTESTATION_PII_KYC,
  ATTESTATION_PAYLOAD_ALLOWED_KEYS,
  ATTESTATION_REFUSE_CODES,
  ATTESTATION_THREAT_MODEL_UNMET,
  AttestationSurfaceError,
  CARD_RASTER_ALLOWED_KEYS,
  CARD_RENDER_ALLOWED_KEYS,
  CARD_SUBJECT_ALLOWED_KEYS,
  P0_12_SEAL_TOKEN,
  THREAT_MODEL_RELATIVE_PATH,
  THREAT_MODEL_REQUIRED_HEADINGS,
  assertZeroPiiSurface,
  decideAttestationProductDone,
  evaluateThreatModelBar,
  inspectZeroPiiPayload,
  issueRankAttestation,
  refuseCodeForPiiKey,
} from './zero-pii.js';

const PROFILE: BlueprintProfile = {
  decisionStyle: 'analytical',
  riskTemperament: 'measured',
  energyRhythm: 'dawn',
  learningMode: 'hands_on',
  crewRole: 'anchor',
  curriculumPath: 'foundations',
  toneRegister: 'direct',
  guardrails: { maxLeverage: 2, dailyLossPromptPct: 5, confirmBeforeMarketOrder: true, copyTradingVisible: false },
};

const SUBJECT: CardSubject = { profile: PROFILE, crewName: 'Iron Meridian', season: 1 };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

function shippedThreatModel(): string {
  return readFileSync(join(REPO_ROOT, THREAT_MODEL_RELATIVE_PATH), 'utf8');
}

describe('D26-P1-I4 named refuse codes', () => {
  it('refuses identity, KYC, custodial userId, and cross-plane address by name', () => {
    expect(refuseCodeForPiiKey('email')).toBe(ATTESTATION_PII_IDENTITY);
    expect(refuseCodeForPiiKey('legalName')).toBe(ATTESTATION_PII_IDENTITY);
    expect(refuseCodeForPiiKey('kycStatus')).toBe(ATTESTATION_PII_KYC);
    expect(refuseCodeForPiiKey('userId')).toBe(ATTESTATION_PII_CUSTODIAL_USER_ID);
    expect(refuseCodeForPiiKey('custodialUserId')).toBe(ATTESTATION_PII_CUSTODIAL_USER_ID);
    expect(refuseCodeForPiiKey('walletAddress')).toBe(ATTESTATION_PII_CROSS_PLANE_ADDRESS);
    expect(refuseCodeForPiiKey('evmAddress')).toBe(ATTESTATION_PII_CROSS_PLANE_ADDRESS);
    expect(refuseCodeForPiiKey('smartAccount')).toBe(ATTESTATION_PII_CROSS_PLANE_ADDRESS);
  });

  it('does not treat card DTO keys as PII', () => {
    for (const key of [...CARD_RENDER_ALLOWED_KEYS, ...CARD_RASTER_ALLOWED_KEYS, ...CARD_SUBJECT_ALLOWED_KEYS]) {
      expect(refuseCodeForPiiKey(key), key).toBeNull();
    }
    for (const key of ATTESTATION_PAYLOAD_ALLOWED_KEYS) {
      expect(refuseCodeForPiiKey(key), key).toBeNull();
    }
  });
});

describe('card / attestation DTO PII sneak', () => {
  it('fails when a custodial userId is smuggled onto a card render DTO', () => {
    const sneaked = {
      size: 'portrait' as const,
      width: CARD_DIMENSIONS.portrait.width,
      height: CARD_DIMENSIONS.portrait.height,
      svg: '<svg/>',
      raster: { status: 'unavailable' as const, code: 'blueprint.card_renderer_unconfigured' as const, reason: 'x' },
      shareMode: 'svg' as const,
      userId: '11111111-1111-4111-8111-111111111111',
    };
    const result = inspectZeroPiiPayload(sneaked);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ATTESTATION_PII_CUSTODIAL_USER_ID);
      expect(result.field).toBe('userId');
    }
  });

  it('fails when KYC lands on an attestation payload', () => {
    const result = inspectZeroPiiPayload({ schemaVersion: 1, kind: 'rank', kycStatus: 'passed' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ATTESTATION_PII_KYC);
  });

  it('fails when identity (email) lands on an attestation payload', () => {
    const result = inspectZeroPiiPayload({ schemaVersion: 1, kind: 'rank', email: 'a@b.c' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ATTESTATION_PII_IDENTITY);
  });

  it('refuses camel-case phoneNumber, emailAddress, and dateOfBirth the same as phone, email, and birthdate', () => {
    const refused = (field: string, value: string) => {
      const result = inspectZeroPiiPayload({ schemaVersion: 1, kind: 'rank', [field]: value });
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.code, field).toBe(ATTESTATION_PII_IDENTITY);
      const nested = inspectZeroPiiPayload({ cards: [{ [field]: value }] });
      expect(nested.ok, field).toBe(false);
      if (!nested.ok) expect(nested.code, field).toBe(ATTESTATION_PII_IDENTITY);
      expect(() => composeCard({ ...SUBJECT, [field]: value } as CardSubject, 'portrait'), field).toThrow(AttestationSurfaceError);
    };
    refused('phone', '555');
    refused('phoneNumber', '555');
    refused('email', 'a@b.c');
    refused('emailAddress', 'a@b.c');
    refused('birthdate', '1990-01-01');
    refused('dateOfBirth', '1990-01-01');
    expect(inspectZeroPiiPayload({ schemaVersion: 1, kind: 'rank', rank: 'sovereign', season: 1, crewRole: 'anchor' }).ok).toBe(true);
  });

  it('fails when a nested cross-plane address lands on an attestation payload', () => {
    const result = inspectZeroPiiPayload({ schemaVersion: 1, kind: 'rank', link: { walletAddress: '0xabc' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ATTESTATION_PII_CROSS_PLANE_ADDRESS);
  });

  it('throws from compose when a CardSubject is stuffed with userId', () => {
    const stuffed = { ...SUBJECT, userId: '11111111-1111-4111-8111-111111111111' };
    expect(() => composeCard(stuffed as CardSubject, 'portrait')).toThrow(AttestationSurfaceError);
    try {
      composeCard(stuffed as CardSubject, 'portrait');
    } catch (err) {
      expect(err).toMatchObject({ code: ATTESTATION_PII_CUSTODIAL_USER_ID, field: 'userId' });
    }
  });

  it('lets a legal card subject compose', () => {
    expect(() => composeCard(SUBJECT, 'portrait')).not.toThrow();
    expect(() => assertZeroPiiSurface('card.subject', SUBJECT)).not.toThrow();
  });

  it('lets a legal card render DTO pass', () => {
    const dto = {
      size: 'portrait',
      width: 1080,
      height: 1350,
      svg: '<svg/>',
      raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'none' },
      shareMode: 'svg',
    };
    expect(inspectZeroPiiPayload(dto).ok).toBe(true);
  });
});

describe('P0-12 threat-model bar — product Done refuse', () => {
  it('refuses product Done when markdown is empty', () => {
    const d = decideAttestationProductDone('');
    expect(d.status).toBe('refuse');
    if (d.status === 'refuse') {
      expect(d.code).toBe(ATTESTATION_THREAT_MODEL_UNMET);
      expect(d.trackerMayFlipDone).toBe(false);
    }
  });

  it('keeps the shipped threat-model page unmet (no seal)', () => {
    const md = shippedThreatModel();
    for (const heading of THREAT_MODEL_REQUIRED_HEADINGS) {
      expect(md).toContain(heading);
    }
    expect(md).not.toContain(P0_12_SEAL_TOKEN);
    const bar = evaluateThreatModelBar(md);
    expect(bar.met).toBe(false);
    if (!bar.met) expect(bar.code).toBe(ATTESTATION_THREAT_MODEL_UNMET);
    const done = decideAttestationProductDone(md);
    expect(done.status).toBe('refuse');
  });

  it('only meets the bar with seal plus required headings', () => {
    const sealed = `${THREAT_MODEL_REQUIRED_HEADINGS.join('\n')}\n${P0_12_SEAL_TOKEN}\n`;
    expect(evaluateThreatModelBar(sealed).met).toBe(true);
    expect(decideAttestationProductDone(sealed).status).toBe('ok');
  });
});

describe('issueRankAttestation — never a chain write', () => {
  it('refuses threat-model-unmet first', () => {
    const issued = issueRankAttestation({
      threatModelMarkdown: shippedThreatModel(),
      payload: { schemaVersion: 1, kind: 'rank', rank: 'sovereign' },
    });
    expect(issued.status).toBe('refuse');
    expect(issued.code).toBe(ATTESTATION_THREAT_MODEL_UNMET);
    expect(issued.leftover).toBe('on-chain Shehzad');
  });

  it('names PII even if a future seal exists', () => {
    const sealed = `${THREAT_MODEL_REQUIRED_HEADINGS.join('\n')}\n${P0_12_SEAL_TOKEN}\n`;
    const issued = issueRankAttestation({
      threatModelMarkdown: sealed,
      payload: { schemaVersion: 1, kind: 'rank', userId: 'abc' },
    });
    expect(issued.code).toBe(ATTESTATION_PII_CUSTODIAL_USER_ID);
  });

  it('refuses on-chain as Shehzad leftover when bar is met and payload is clean', () => {
    const sealed = `${THREAT_MODEL_REQUIRED_HEADINGS.join('\n')}\n${P0_12_SEAL_TOKEN}\n`;
    const issued = issueRankAttestation({
      threatModelMarkdown: sealed,
      payload: { schemaVersion: 1, kind: 'rank', rank: 'sovereign', season: 1 },
    });
    expect(issued.code).toBe(ATTESTATION_ON_CHAIN_UNBUILT);
    expect(issued.leftover).toBe('on-chain Shehzad');
  });

  it('exports the six refuse codes this slice owns', () => {
    expect([...ATTESTATION_REFUSE_CODES]).toEqual([
      ATTESTATION_THREAT_MODEL_UNMET,
      ATTESTATION_PII_IDENTITY,
      ATTESTATION_PII_KYC,
      ATTESTATION_PII_CUSTODIAL_USER_ID,
      ATTESTATION_PII_CROSS_PLANE_ADDRESS,
      ATTESTATION_ON_CHAIN_UNBUILT,
    ]);
  });
});
