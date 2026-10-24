import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

const uuid = z.string().guid();
const instant = z
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
const counter = z.number().int().nonnegative().max(2147483647);
const link = z.object({ token: uuid, referrerId: uuid, hits: counter });
export type ShareLink = z.infer<typeof link>;
export const currentLinkReply = (owner: string) => link.refine((value) => value.referrerId === owner);
export const currentRevocationReply = (owner: string) => link.extend({ revokedAt: instant }).refine((value) => value.referrerId === owner);
export type RevokedLink = z.infer<ReturnType<typeof currentRevocationReply>>;
export const shareKind = z.enum(['create', 'revoke-current']);
export type ShareKind = z.infer<typeof shareKind>;
const original = z.object({ owner: uuid, kind: shareKind, requestId: uuid, createdAt: instant }).strict();
export type ShareOriginal = z.infer<typeof original>;
export type ShareJournal = { records: ShareOriginal[]; failed: boolean };
const journal = z.array(original).refine((rows) => new Set(rows.map((row) => row.requestId)).size === rows.length);
export const shareKey = (owner: string) => 'intafaced.customer.promotions.v1:' + owner;
export const shareLock = (owner: string) => 'customer-promotions:' + owner;
export const sameShareOriginal = (a: ShareOriginal, b: ShareOriginal) =>
  a.owner === b.owner && a.kind === b.kind && a.requestId === b.requestId && a.createdAt === b.createdAt;
export function readShares(owner: string): ShareJournal {
  try {
    const text = localStorage.getItem(shareKey(owner));
    if (text === null) return { records: [], failed: false };
    const parsed = journal.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.every((row) => row.owner === owner)
      ? { records: parsed.data, failed: false }
      : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
export const sharesBlocked = (value: ShareJournal) => value.failed || value.records.length > 0;
function write(owner: string, records: ShareOriginal[]) {
  const parsed = journal.safeParse(records);
  if (!parsed.success || parsed.data.some((row) => row.owner !== owner)) return false;
  try {
    if (parsed.data.length) localStorage.setItem(shareKey(owner), JSON.stringify(parsed.data));
    else localStorage.removeItem(shareKey(owner));
    const actual = readShares(owner);
    return !actual.failed && JSON.stringify(actual.records) === JSON.stringify(parsed.data);
  } catch {
    return false;
  }
}
/** Call only under this owner's Web Lock. No capability or private request body is saved. */
export function saveShare(value: ShareOriginal) {
  const current = readShares(value.owner);
  return !sharesBlocked(current) && write(value.owner, [...current.records, value]);
}
/** Only a matching known original. A later current-link call never settles an older unknown. */
export function finishShare(value: ShareOriginal) {
  const current = readShares(value.owner);
  if (current.failed || !current.records.some((row) => sameShareOriginal(row, value))) return false;
  return write(
    value.owner,
    current.records.filter((row) => !sameShareOriginal(row, value)),
  );
}
/** Source-verified pre-effect errors only. Neither generic4xx nor later not_found proves an earlier call. */
export function shareRefused(kind: ShareKind, answer: ApiResult<unknown>) {
  if (answer.ok || answer.messageCopy) return false;
  if (answer.status === 400 && answer.reason === 'error' && answer.code === 'share.invalid') return true;
  return (
    answer.status === 404 &&
    answer.reason === 'not_mounted' &&
    answer.code === (kind === 'create' ? 'share.profile_gone' : 'share.not_found')
  );
}
