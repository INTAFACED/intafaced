import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

const uuid = z.string().guid();
export const verificationInstant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const parts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(value);
    if (!parts || !Number.isFinite(Date.parse(value))) return false;
    const date = new Date(0);
    date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return (
      date.getUTCFullYear() === Number(parts[1]) && date.getUTCMonth() === Number(parts[2]) - 1 && date.getUTCDate() === Number(parts[3])
    );
  });
export const verificationTier = z.enum(['none', 'basic', 'full', 'institutional']);
export const requestedTier = z.enum(['basic', 'full', 'institutional']);
export type RequestedTier = z.infer<typeof requestedTier>;
export const verificationRecord = z.object({
  id: uuid,
  userId: uuid,
  tier: verificationTier,
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  reviewedAt: verificationInstant.nullable(),
  expiresAt: verificationInstant.nullable(),
  createdAt: verificationInstant,
});
export type VerificationRecord = z.infer<typeof verificationRecord>;
export function verificationStatus(owner: string, limit: number) {
  return z
    .object({ tier: verificationTier, records: z.array(verificationRecord).max(limit) })
    .refine(
      (value) =>
        new Set(value.records.map((row) => row.id)).size === value.records.length &&
        value.records.every(
          (row, index) =>
            row.userId === owner && (index === 0 || Date.parse(value.records[index - 1]!.createdAt) >= Date.parse(row.createdAt)),
        ),
    );
}
/** submitKyc can return an existing record from ANY jurisdiction. */
export function verificationReply(owner: string, tier: RequestedTier) {
  const order = { none: 0, basic: 1, full: 2, institutional: 3 };
  return verificationRecord.refine(
    (row) =>
      row.userId === owner &&
      ((row.status === 'pending' && row.tier === tier) ||
        (row.status === 'approved' &&
          order[row.tier] >= order[tier] &&
          (row.expiresAt === null || Date.parse(row.expiresAt) > Date.now()))),
  );
}
export const verificationOriginal = z
  .object({ owner: uuid, kind: z.literal('submit'), requestId: uuid, createdAt: verificationInstant })
  .strict();
export type VerificationOriginal = z.infer<typeof verificationOriginal>;
export type VerificationJournal = { records: VerificationOriginal[]; failed: boolean };
const journalSchema = z
  .array(verificationOriginal)
  .max(200)
  .refine((rows) => new Set(rows.map((row) => row.requestId)).size === rows.length);
export const verificationKey = (owner: string) => 'intafaced.customer.verification.v1:' + owner;
export const verificationLock = (owner: string) => 'customer-verification:' + owner;
export function readVerification(owner: string): VerificationJournal {
  try {
    const text = localStorage.getItem(verificationKey(owner));
    if (text === null) return { records: [], failed: false };
    const parsed = journalSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.every((row) => row.owner === owner)
      ? { records: parsed.data, failed: false }
      : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
function writeVerification(owner: string, records: VerificationOriginal[]) {
  const parsed = journalSchema.safeParse(records);
  if (!parsed.success || parsed.data.some((row) => row.owner !== owner)) return false;
  try {
    if (records.length) localStorage.setItem(verificationKey(owner), JSON.stringify(parsed.data));
    else localStorage.removeItem(verificationKey(owner));
    const actual = readVerification(owner);
    return !actual.failed && JSON.stringify(actual.records) === JSON.stringify(parsed.data);
  } catch {
    return false;
  }
}
export const verificationBlocked = (journal: VerificationJournal) => journal.failed || journal.records.length > 0;
/** Only while holding this owner's Web Lock; no private terms or credentials are serialized. */
export function saveVerification(original: VerificationOriginal) {
  const current = readVerification(original.owner);
  return !verificationBlocked(current) && writeVerification(original.owner, [...current.records, original]);
}
/** Exact matching known attempt only. Current lists never settle an unknown. */
export function finishVerification(original: VerificationOriginal) {
  const current = readVerification(original.owner);
  const found = current.records.find((row) => row.requestId === original.requestId);
  if (current.failed || !found || found.owner !== original.owner || found.kind !== original.kind || found.createdAt !== original.createdAt)
    return false;
  return writeVerification(
    original.owner,
    current.records.filter((row) => row.requestId !== original.requestId),
  );
}
/** Actual kyc.submit router maps the missing owner SELECT to localized404 with
 * this named cause before existing-record selection or INSERT. No generic4xx/500.
 * The attempt limit (I-kyc-compliance-10) refuses inside the same transaction before the INSERT: 429 with its code.
 * A level that grants a capability compliance switched off (I-kyc-compliance-07) refuses there too: 409 with its code. */
export function verificationRefused(answer: ApiResult<unknown>) {
  if (answer.ok) return false;
  if (answer.status === 429 && answer.code === 'kyc.attempts_exhausted') return true;
  if (answer.status === 409 && answer.code === 'kyc.capability_inactive') return true;
  return answer.status === 404 && answer.reason === 'not_mounted' && answer.code === 'auth.not_found' && !answer.messageCopy;
}
