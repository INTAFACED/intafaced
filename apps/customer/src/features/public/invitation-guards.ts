import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

const uuid = z.string().uuid();
export const invitationInstant = z
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

export const invitationReply = z.object({ hits: z.number().int().nonnegative().safe(), attributed: z.boolean() });
export function currentReferrerFor(owner: string) {
  return z
    .object({ userId: uuid, referrerId: uuid, attributedAt: invitationInstant })
    .refine((row) => row.userId === owner && row.referrerId !== owner)
    .nullable();
}
/** Referral refusals that come after the visit counted: the visit is recorded, no relationship is attached. */
export const REFERRAL_REFUSALS = [
  'referral.self',
  'referral.already_set',
  'referral.cycle',
  'referral.depth',
  'referral.attach_window_closed',
  'referral.attach_window_unset',
] as const;
export type ReferralRefusal = (typeof REFERRAL_REFUSALS)[number];
export const referralRefusal = (code: string | undefined): ReferralRefusal | null =>
  (REFERRAL_REFUSALS as readonly string[]).includes(code ?? '') ? (code as ReferralRefusal) : null;

export const attachWindowSchema = z.object({
  state: z.enum(['unset', 'open', 'closed']),
  accountCreatedAt: invitationInstant,
  windowSeconds: z.number().int().positive().nullable(),
  closesAt: invitationInstant.nullable(),
});
export type AttachWindow = z.infer<typeof attachWindowSchema>;

export type CurrentReferrer = z.infer<ReturnType<typeof currentReferrerFor>>;

const recordSchema = z.object({ owner: uuid, kind: z.literal('invitation-accept'), localRef: uuid, createdAt: invitationInstant }).strict();
export type InvitationRecord = z.infer<typeof recordSchema>;
export type InvitationJournal = { records: InvitationRecord[]; failed: boolean };
const journalSchema = z.array(recordSchema).refine((rows) => new Set(rows.map((row) => row.localRef)).size === rows.length);
export const invitationKey = (owner: string) => 'intafaced.customer.invitation.v1:' + owner;
export const invitationLock = (owner: string) => 'customer-invitation:' + owner;

export function readInvitations(owner: string): InvitationJournal {
  try {
    const raw = localStorage.getItem(invitationKey(owner));
    if (raw === null) return { records: [], failed: false };
    const parsed = journalSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.every((row) => row.owner === owner)
      ? { records: parsed.data, failed: false }
      : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
function writeInvitations(owner: string, records: InvitationRecord[]): boolean {
  const parsed = journalSchema.safeParse(records);
  if (!parsed.success || parsed.data.some((row) => row.owner !== owner)) return false;
  try {
    if (records.length) localStorage.setItem(invitationKey(owner), JSON.stringify(parsed.data));
    else localStorage.removeItem(invitationKey(owner));
    const actual = readInvitations(owner);
    return !actual.failed && JSON.stringify(actual.records) === JSON.stringify(parsed.data);
  } catch {
    return false;
  }
}
/** Only under this owner's Web Lock. The capability, URL and credentials stay in memory. */
export function saveInvitation(record: InvitationRecord): boolean {
  const current = readInvitations(record.owner);
  return !current.failed && current.records.length === 0 && writeInvitations(record.owner, [record]);
}
/** Local cleanup of this exact known original; never sends or reconstructs an acceptance. */
export function finishInvitation(original: InvitationRecord): boolean {
  const current = readInvitations(original.owner);
  const found = current.records.find((row) => row.localRef === original.localRef);
  if (
    current.failed ||
    !found ||
    found.owner !== original.owner ||
    found.kind !== original.kind ||
    found.localRef !== original.localRef ||
    found.createdAt !== original.createdAt
  )
    return false;
  return writeInvitations(
    original.owner,
    current.records.filter((row) => row.localRef !== original.localRef),
  );
}

/** Exact ShareService refusals before UPDATE hits. Referral errors happen after the hit
 * and have no safe before-effect classification, including generic HTTP4xx/5xx. */
export function isInvitationRefusal(answer: ApiResult<unknown>): boolean {
  if (answer.ok || answer.messageCopy) return false;
  switch (answer.code) {
    case 'share.unknown':
      return answer.status === 404 && answer.reason === 'not_mounted' && answer.message === 'Share token is unknown [share.unknown]';
    case 'share.revoked':
      return answer.status === 403 && answer.reason === 'forbidden' && answer.message === 'Share token is revoked [share.revoked]';
    case 'share.profile_gone':
      return answer.status === 404 && answer.reason === 'not_mounted' && answer.message === 'Referrer profile is gone [share.profile_gone]';
    // The visit was recorded, then the referral was refused by name (J-campaigns-05 #4 and #5): nothing was attached.
    case 'referral.self':
    case 'referral.already_set':
    case 'referral.cycle':
    case 'referral.depth':
      return answer.status === 409;
    case 'referral.attach_window_closed':
      return answer.status === 403;
    case 'referral.attach_window_unset':
      return answer.status === 412;
    default:
      return false;
  }
}
