/**
 * One selfie as identity's compliance doors answer it (`kyc.selfie.listFor`, `kyc.selfie.decide`, I-kyc-compliance-09), and
 * the decisions a person can make on one. Pure: the server reads identity's answer with it, and the browser reads a row with it.
 */

export const SELFIE_STATUSES = ['provided', 'accepted', 'rejected'] as const;
export type SelfieStatus = (typeof SELFIE_STATUSES)[number];

export interface DecidedSelfie {
  readonly id: string;
  readonly status: SelfieStatus;
  readonly documentId: string;
  readonly decidedAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Strict reader of identity's selfie answer: the fields the console acts on, well formed, or null. */
export function readSelfie(raw: unknown): DecidedSelfie | null {
  if (!isRecord(raw)) return null;
  const { id, status, documentId, decidedAt } = raw;
  if (typeof id !== 'string' || !UUID.test(id) || typeof documentId !== 'string' || !UUID.test(documentId)) return null;
  if (typeof status !== 'string' || !(SELFIE_STATUSES as readonly string[]).includes(status)) return null;
  if (!(decidedAt === null || (typeof decidedAt === 'string' && Number.isFinite(Date.parse(decidedAt))))) return null;
  return { id, status: status as SelfieStatus, documentId, decidedAt };
}
