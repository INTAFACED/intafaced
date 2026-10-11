/**
 * D26-P1-I4 — zero-PII bar on Blueprint card / rank-attestation surfaces (§19).
 *
 * Product Done for `blueprint.attestations` stays refused while P0-12 is unmet
 * (no `P0-12-ATTESTATION-THREAT-SEALED` token in the threat-model doc). On-chain
 * issuance is Shehzad leftover — this module never talks to a chain.
 *
 * Leverage: Phase A IN `S-BLUEPRINT` (`services/svc-blueprint` card compose +
 * DTO). Horizon row is **S** for the on-chain half; this slice is Fiat-plane
 * refuse only.
 */

export const P0_12_SEAL_TOKEN = 'P0-12-ATTESTATION-THREAT-SEALED' as const;
export const THREAT_MODEL_RELATIVE_PATH = 'docs/THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md' as const;

export const ATTESTATION_THREAT_MODEL_UNMET = 'blueprint.attestation_threat_model_unmet' as const;
export const ATTESTATION_PII_IDENTITY = 'blueprint.attestation_pii_identity' as const;
export const ATTESTATION_PII_KYC = 'blueprint.attestation_pii_kyc' as const;
export const ATTESTATION_PII_CUSTODIAL_USER_ID = 'blueprint.attestation_pii_custodial_user_id' as const;
export const ATTESTATION_PII_CROSS_PLANE_ADDRESS = 'blueprint.attestation_pii_cross_plane_address' as const;
export const ATTESTATION_ON_CHAIN_UNBUILT = 'blueprint.attestation_on_chain_unbuilt' as const;

export type AttestationPiiRefuseCode =
  | typeof ATTESTATION_PII_IDENTITY
  | typeof ATTESTATION_PII_KYC
  | typeof ATTESTATION_PII_CUSTODIAL_USER_ID
  | typeof ATTESTATION_PII_CROSS_PLANE_ADDRESS;

export type AttestationRefuseCode = typeof ATTESTATION_THREAT_MODEL_UNMET | AttestationPiiRefuseCode | typeof ATTESTATION_ON_CHAIN_UNBUILT;

export const THREAT_MODEL_REQUIRED_HEADINGS = [
  '## Assets',
  '## Adversaries',
  '## Trust boundaries',
  '## Zero-PII bar',
  '## Product Done',
] as const;

/** Keys that may appear on a share-card DTO (`cardRenderSchema`). */
export const CARD_RENDER_ALLOWED_KEYS = ['size', 'width', 'height', 'svg', 'raster', 'shareMode'] as const;

/** Nested raster object keys. `url` is a PNG rail URL, not a chain address. */
export const CARD_RASTER_ALLOWED_KEYS = ['status', 'url', 'contentType', 'bytes', 'code', 'reason'] as const;

/** Keys that may appear on the compose subject. */
export const CARD_SUBJECT_ALLOWED_KEYS = ['profile', 'crewName', 'season'] as const;

/**
 * Rank-attestation payload allow-list (Fiat-plane DTO). Rank/standing only —
 * never a person. On-chain encoding of this object is Shehzad, not this file.
 */
export const ATTESTATION_PAYLOAD_ALLOWED_KEYS = ['schemaVersion', 'kind', 'rank', 'crewRole', 'season', 'commitment'] as const;

type PiiCategory = 'identity' | 'kyc' | 'custodial_user_id' | 'cross_plane_address';

const CATEGORY_CODE: Record<PiiCategory, AttestationPiiRefuseCode> = {
  identity: ATTESTATION_PII_IDENTITY,
  kyc: ATTESTATION_PII_KYC,
  custodial_user_id: ATTESTATION_PII_CUSTODIAL_USER_ID,
  cross_plane_address: ATTESTATION_PII_CROSS_PLANE_ADDRESS,
};

/** Normalized key → named refuse category. */
const FORBIDDEN_NORMALIZED: Readonly<Record<string, PiiCategory>> = {
  identity: 'identity',
  identityid: 'identity',
  legalname: 'identity',
  fullname: 'identity',
  firstname: 'identity',
  lastname: 'identity',
  displayname: 'identity',
  givenname: 'identity',
  name: 'identity',
  email: 'identity',
  phone: 'identity',
  handle: 'identity',
  username: 'identity',
  avatar: 'identity',
  birthdata: 'identity',
  birthdate: 'identity',
  birthtime: 'identity',
  birthplace: 'identity',
  governmentid: 'identity',
  nationalid: 'identity',
  passport: 'identity',
  ssn: 'identity',
  kyc: 'kyc',
  kycstatus: 'kyc',
  kycid: 'kyc',
  kycdocument: 'kyc',
  verificationlevel: 'kyc',
  aml: 'kyc',
  userid: 'custodial_user_id',
  custodialuserid: 'custodial_user_id',
  customerid: 'custodial_user_id',
  ledgeruserid: 'custodial_user_id',
  accountid: 'custodial_user_id',
  walletaddress: 'cross_plane_address',
  evmaddress: 'cross_plane_address',
  chainaddress: 'cross_plane_address',
  onchainaddress: 'cross_plane_address',
  crossplaneaddress: 'cross_plane_address',
  smartaccount: 'cross_plane_address',
  intachainaddress: 'cross_plane_address',
  publickey: 'cross_plane_address',
};

/** Camel-case forms whose stripped spelling is not the denylist key. */
const CAMEL_CASE_PII_FOLDS: Readonly<Record<string, string>> = {
  phonenumber: 'phone',
  emailaddress: 'email',
  dateofbirth: 'birthdate',
};

export function normalizeSurfaceKey(key: string): string {
  const flat = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return CAMEL_CASE_PII_FOLDS[flat] ?? flat;
}

export function piiCategoryForKey(key: string): PiiCategory | null {
  return FORBIDDEN_NORMALIZED[normalizeSurfaceKey(key)] ?? null;
}

export function refuseCodeForPiiKey(key: string): AttestationPiiRefuseCode | null {
  const category = piiCategoryForKey(key);
  return category ? CATEGORY_CODE[category] : null;
}

export class AttestationSurfaceError extends Error {
  constructor(
    message: string,
    readonly code: AttestationRefuseCode,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'AttestationSurfaceError';
  }
}

export type ThreatModelBar =
  | { readonly met: true }
  | { readonly met: false; readonly code: typeof ATTESTATION_THREAT_MODEL_UNMET; readonly missing: readonly string[] };

/**
 * P0-12 bar: headings present AND owner seal token. Absence of the file is
 * passed as empty markdown → unmet.
 */
export function evaluateThreatModelBar(markdown: string): ThreatModelBar {
  const missing: string[] = [];
  if (!markdown.includes(P0_12_SEAL_TOKEN)) missing.push('seal');
  for (const heading of THREAT_MODEL_REQUIRED_HEADINGS) {
    if (!markdown.includes(heading)) missing.push(heading);
  }
  if (missing.length > 0) {
    return { met: false, code: ATTESTATION_THREAT_MODEL_UNMET, missing };
  }
  return { met: true };
}

export type ProductDoneDecision =
  | { readonly status: 'ok' }
  | {
      readonly status: 'refuse';
      readonly code: typeof ATTESTATION_THREAT_MODEL_UNMET;
      readonly message: string;
      readonly trackerMayFlipDone: false;
    };

/** Product Done for blueprint.attestations — refuse while P0-12 is unmet. */
export function decideAttestationProductDone(threatModelMarkdown: string): ProductDoneDecision {
  const bar = evaluateThreatModelBar(threatModelMarkdown);
  if (!bar.met) {
    return {
      status: 'refuse',
      code: ATTESTATION_THREAT_MODEL_UNMET,
      message:
        'blueprint.attestations product Done is refused — P0-12 threat-model bar unmet (no seal and/or missing required headings). Tracker stays not done.',
      trackerMayFlipDone: false,
    };
  }
  return { status: 'ok' };
}

function walkKeys(value: unknown, into: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, into);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    into.push(key);
    walkKeys(child, into);
  }
}

export function collectKeys(value: unknown): string[] {
  const keys: string[] = [];
  walkKeys(value, keys);
  return keys;
}

export type ZeroPiiOk = { readonly ok: true };
export type ZeroPiiRefuse = {
  readonly ok: false;
  readonly code: AttestationPiiRefuseCode;
  readonly field: string;
  readonly message: string;
};

/** Fail closed if identity / KYC / custodial userId / cross-plane address keys appear. */
export function inspectZeroPiiPayload(payload: unknown): ZeroPiiOk | ZeroPiiRefuse {
  for (const field of collectKeys(payload)) {
    const code = refuseCodeForPiiKey(field);
    if (code) {
      return {
        ok: false,
        code,
        field,
        message: `attestation/card payload refuses PII field ${field} (${code})`,
      };
    }
  }
  return { ok: true };
}

export function assertZeroPiiSurface(surface: string, payload: unknown): void {
  const result = inspectZeroPiiPayload(payload);
  if (!result.ok) {
    throw new AttestationSurfaceError(`${surface}: ${result.message}`, result.code, result.field);
  }
}

export type RankAttestationIssue =
  | {
      readonly status: 'refuse';
      readonly code: typeof ATTESTATION_THREAT_MODEL_UNMET;
      readonly message: string;
      readonly leftover: 'on-chain Shehzad';
    }
  | {
      readonly status: 'refuse';
      readonly code: AttestationPiiRefuseCode;
      readonly field: string;
      readonly message: string;
      readonly leftover: 'on-chain Shehzad';
    }
  | {
      readonly status: 'refuse';
      readonly code: typeof ATTESTATION_ON_CHAIN_UNBUILT;
      readonly message: string;
      readonly leftover: 'on-chain Shehzad';
    };

/**
 * Fiat-plane issuer door. Never succeeds: P0-12 unmet → refuse; PII → named
 * refuse; otherwise on-chain unbuilt (Shehzad). No Solidity, no svc-protocol.
 */
export function issueRankAttestation(input: { readonly threatModelMarkdown: string; readonly payload: unknown }): RankAttestationIssue {
  const done = decideAttestationProductDone(input.threatModelMarkdown);
  if (done.status === 'refuse') {
    return {
      status: 'refuse',
      code: done.code,
      message: done.message,
      leftover: 'on-chain Shehzad',
    };
  }
  const pii = inspectZeroPiiPayload(input.payload);
  if (!pii.ok) {
    return {
      status: 'refuse',
      code: pii.code,
      field: pii.field,
      message: pii.message,
      leftover: 'on-chain Shehzad',
    };
  }
  return {
    status: 'refuse',
    code: ATTESTATION_ON_CHAIN_UNBUILT,
    message:
      'Rank attestation on-chain issuance is unbuilt — leftover for Shehzad (protocol/INTACHAIN). Fiat plane will not invent a chain write.',
    leftover: 'on-chain Shehzad',
  };
}

export const ATTESTATION_REFUSE_CODES = [
  ATTESTATION_THREAT_MODEL_UNMET,
  ATTESTATION_PII_IDENTITY,
  ATTESTATION_PII_KYC,
  ATTESTATION_PII_CUSTODIAL_USER_ID,
  ATTESTATION_PII_CROSS_PLANE_ADDRESS,
  ATTESTATION_ON_CHAIN_UNBUILT,
] as const;
