import { z } from 'zod';
import { credentialIdSchema as credentialId, securityInstantSchema as securityInstant } from '@intafaced/contracts/identity-account-room';

/**
 * This browser's own journal of the account security changes it has sent (localStorage, per owner): what a reload must
 * not send twice. Never a service's answer; the answers are read in security-guards.ts from `@intafaced/contracts`.
 */
const uuid = z.string().guid();
const securityKind = z.enum(['options', 'register', 'remove', 'setup', 'confirm', 'logout']);
export type SecurityKind = z.infer<typeof securityKind>;
const securityRecord = z
  .object({
    requestId: uuid,
    owner: uuid,
    createdAt: securityInstant,
    kind: securityKind,
    state: z.enum(['sent', 'prepared']),
    credential: credentialId.optional(),
    setupRequest: uuid.optional(),
  })
  .strict()
  .refine(
    (record) =>
      (record.state !== 'prepared' || record.kind === 'setup') &&
      (record.kind === 'register' || record.kind === 'remove') === (record.credential !== undefined) &&
      (record.kind === 'confirm') === (record.setupRequest !== undefined),
  );
export type SecurityRecord = z.infer<typeof securityRecord>;
export type SecurityJournal = { records: SecurityRecord[]; failed: boolean };
export const securityKey = (owner: string) => 'intafaced.customer.security.v1:' + owner;
export const securitySessionLock = (owner: string) => 'customer-session-revoke:' + owner;
const recordsSchema = z
  .array(securityRecord)
  .max(50)
  .refine((records) => new Set(records.map((record) => record.requestId)).size === records.length);
export function readSecurity(owner: string): SecurityJournal {
  try {
    const text = localStorage.getItem(securityKey(owner));
    if (text === null) return { records: [], failed: false };
    const result = recordsSchema.safeParse(JSON.parse(text));
    return result.success && result.data.every((record) => record.owner === owner)
      ? { records: result.data, failed: false }
      : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
function writeRecords(owner: string, records: SecurityRecord[]): boolean {
  const parsed = recordsSchema.safeParse(records);
  if (!parsed.success) return false;
  const canonical = parsed.data;
  try {
    if (canonical.length === 0) localStorage.removeItem(securityKey(owner));
    else localStorage.setItem(securityKey(owner), JSON.stringify(canonical));
    const actual = readSecurity(owner);
    return !actual.failed && JSON.stringify(actual.records) === JSON.stringify(canonical);
  } catch {
    return false;
  }
}
/** Called under the owner Web Lock. Only nonsecret original references are serialized. */
export function saveSecurity(record: SecurityRecord): boolean {
  const current = readSecurity(record.owner);
  if (current.failed || current.records.some((row) => row.requestId === record.requestId)) return false;
  return writeRecords(record.owner, [...current.records, record]);
}
export function finishSecurity(original: SecurityRecord): boolean {
  const current = readSecurity(original.owner);
  const found = current.records.find((row) => row.requestId === original.requestId);
  if (current.failed || !found || !sameRecord(found, original)) return false;
  return writeRecords(
    original.owner,
    current.records.filter((row) => row.requestId !== original.requestId),
  );
}
/** A known setup replaces only known prepared setups; uncertain preparations remain original records. */
export function prepareSecurity(original: SecurityRecord): boolean {
  const current = readSecurity(original.owner);
  const found = current.records.find((row) => row.requestId === original.requestId);
  if (current.failed || original.kind !== 'setup' || !found || !sameRecord(found, original)) return false;
  return writeRecords(original.owner, [
    ...current.records.filter((row) => row.requestId !== original.requestId && row.state !== 'prepared'),
    { ...original, state: 'prepared' },
  ]);
}
function sameRecord(a: SecurityRecord, b: SecurityRecord) {
  return (
    a.requestId === b.requestId &&
    a.owner === b.owner &&
    a.createdAt === b.createdAt &&
    a.kind === b.kind &&
    a.state === b.state &&
    a.credential === b.credential &&
    a.setupRequest === b.setupRequest
  );
}
