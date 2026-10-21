import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

const uuid = z.string().uuid();
export const subaccountInstant = z
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
export const subaccount = z.object({
  id: uuid,
  label: z.string().min(1).max(64),
  purpose: z.string().max(200).nullable(),
  revoked: z.boolean(),
  frozen: z.boolean(),
  kind: z.enum(['standard', 'managed', 'derivatives', 'spot']),
  nickname: z.string().nullable(),
  createdAt: subaccountInstant,
});
export type Subaccount = z.infer<typeof subaccount>;
export const KIND_KEYS: Readonly<Record<Subaccount['kind'], string>> = {
  standard: 'kindStandard',
  managed: 'kindManaged',
  derivatives: 'kindDerivatives',
  spot: 'kindSpot',
};
export function subaccountsIn(limit: number) {
  return z
    .array(subaccount)
    .max(limit)
    .refine(
      (rows) =>
        new Set(rows.map((row) => row.id)).size === rows.length &&
        rows.every((row, i) => i === 0 || Date.parse(rows[i - 1]!.createdAt) >= Date.parse(row.createdAt)),
    );
}
export function sameSubaccount(a: Subaccount, b: Subaccount) {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.purpose === b.purpose &&
    a.revoked === b.revoked &&
    a.frozen === b.frozen &&
    a.kind === b.kind &&
    a.nickname === b.nickname &&
    a.createdAt === b.createdAt
  );
}
export type SubaccountKind = 'create' | 'revoke';
export const subaccountRecord = z
  .object({
    owner: uuid,
    requestId: uuid,
    kind: z.enum(['create', 'revoke']),
    target: uuid.optional(),
    createdAt: subaccountInstant,
  })
  .strict()
  .refine((record) => (record.kind === 'revoke') === (record.target !== undefined));
export type SubaccountRecord = z.infer<typeof subaccountRecord>;
export type SubaccountJournal = { records: SubaccountRecord[]; failed: boolean };
export const subaccountKey = (owner: string) => 'intafaced.customer.subaccounts.v1:' + owner;
export const subaccountLock = (owner: string) => 'customer-subaccounts:' + owner;
const recordsSchema = z
  .array(subaccountRecord)
  .max(201)
  .refine(
    (records) =>
      new Set(records.map((row) => row.requestId)).size === records.length &&
      new Set(records.map((row) => (row.kind === 'create' ? 'create' : row.target))).size === records.length,
  );
export function readSubaccounts(owner: string): SubaccountJournal {
  try {
    const text = localStorage.getItem(subaccountKey(owner));
    if (text === null) return { records: [], failed: false };
    const parsed = recordsSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.every((row) => row.owner === owner)
      ? { records: parsed.data, failed: false }
      : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
function writeSubaccounts(owner: string, records: SubaccountRecord[]): boolean {
  const parsed = recordsSchema.safeParse(records);
  if (!parsed.success || parsed.data.some((row) => row.owner !== owner)) return false;
  try {
    if (records.length) localStorage.setItem(subaccountKey(owner), JSON.stringify(parsed.data));
    else localStorage.removeItem(subaccountKey(owner));
    const actual = readSubaccounts(owner);
    return !actual.failed && JSON.stringify(actual.records) === JSON.stringify(parsed.data);
  } catch {
    return false;
  }
}
export function subaccountBlocked(journal: SubaccountJournal, kind: SubaccountKind, target?: string) {
  return journal.failed || journal.records.some((row) => row.kind === kind && (kind === 'create' || row.target === target));
}
/** Called only under the original owner's Web Lock. No opaque intent or authentication data is serialized. */
export function saveSubaccount(record: SubaccountRecord): boolean {
  const current = readSubaccounts(record.owner);
  if (subaccountBlocked(current, record.kind, record.target)) return false;
  return writeSubaccounts(record.owner, [...current.records, record]);
}
export function finishSubaccount(original: SubaccountRecord): boolean {
  const current = readSubaccounts(original.owner);
  const found = current.records.find((row) => row.requestId === original.requestId);
  if (
    current.failed ||
    !found ||
    found.owner !== original.owner ||
    found.requestId !== original.requestId ||
    found.kind !== original.kind ||
    found.target !== original.target ||
    found.createdAt !== original.createdAt
  )
    return false;
  return writeSubaccounts(
    original.owner,
    current.records.filter((row) => row.requestId !== original.requestId),
  );
}
/** These four AuthService causes precede INSERT. The real create router emits HTTP500;
 * require its original service explanation, not a generic status or shared fallback.
 * Revocation has no proven before-effect refusal classification. */
export function isCreateRefusal(answer: ApiResult<unknown>): boolean {
  if (answer.ok || answer.status !== 500 || answer.reason !== 'uncertain' || answer.messageCopy) return false;
  switch (answer.code) {
    case 'auth.not_found':
      return answer.message === 'User not found';
    case 'auth.account_frozen':
      return /^Account is (frozen|closed)$/.test(answer.message);
    case 'auth.sub_account_cap_unset':
      return answer.message === 'IDENTITY_MAX_SUB_ACCOUNTS is unset — owner must publish a live-partition cap';
    case 'auth.sub_account_limit':
      return /^Sub-account limit reached \([1-9][0-9]*\)\. Retire a live partition or raise IDENTITY_MAX_SUB_ACCOUNTS\.$/.test(
        answer.message,
      );
    default:
      return false;
  }
}
