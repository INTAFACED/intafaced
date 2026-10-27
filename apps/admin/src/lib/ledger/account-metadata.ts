/**
 * An account's operator metadata on the ledger desk (J-ops-console-03 #6, #7, OPS-ledger-desk-01): the shapes the console
 * reads from svc-ledger through svc-edge, and the checks it makes before sending a write. svc-ledger checks everything
 * again; these only keep a request the ledger would refuse from leaving the console.
 *
 * A founder sets or overwrites a key on one founder's word, from the revision they read. A delete is a two-founder
 * request (`ledger.account_metadata.delete`), bound to the account, the key, the reason and that revision. Both writes
 * refuse `ledger.frozen` while the posting freeze is on; the read still answers.
 *
 * Pure: no Node-only imports, so the browser and the server use the same parser.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** svc-ledger's key rule (`account_metadata_key_ck`, 0029). */
export const METADATA_KEY = /^[a-z][a-z0-9_.:-]{0,63}$/;
export const METADATA_VALUE_MAX = 500;
const REVISION_MAX = 2_147_483_646;

export interface MetadataEntry {
  readonly key: string;
  readonly value: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface MetadataChange {
  readonly seq: string;
  readonly key: string;
  readonly action: 'set' | 'delete';
  readonly before: string | null;
  readonly after: string | null;
  readonly revision: number;
  readonly requesterId: string;
  readonly approverId: string | null;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface AccountMetadata {
  readonly accountId: string;
  readonly address: string;
  readonly entries: readonly MetadataEntry[];
  readonly deleted: readonly { readonly key: string; readonly revision: number }[];
  readonly changes: readonly MetadataChange[];
  readonly frozen: boolean;
}

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const isRevision = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= REVISION_MAX;
const isInstant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isText = (v: unknown): v is string => typeof v === 'string';
const isNullableText = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseEntry(raw: unknown): MetadataEntry | null {
  if (!isRecord(raw)) return null;
  const { key, value, revision, updatedAt, updatedBy } = raw;
  if (!isText(key) || !isText(value) || !isRevision(revision) || !isInstant(updatedAt) || !isText(updatedBy)) return null;
  return { key, value, revision, updatedAt, updatedBy };
}

export function parseMetadataChange(raw: unknown): MetadataChange | null {
  if (!isRecord(raw)) return null;
  const { seq, key, action, before, after, revision, requesterId, approverId, reason, recordedAt } = raw;
  if (!isText(seq) || !/^\d+$/.test(seq) || !isText(key) || (action !== 'set' && action !== 'delete')) return null;
  if (!isNullableText(before) || !isNullableText(after) || !isRevision(revision)) return null;
  if (!isText(requesterId) || !isNullableText(approverId) || !isText(reason) || !isInstant(recordedAt)) return null;
  return { seq, key, action, before, after, revision, requesterId, approverId, reason, recordedAt };
}

/** svc-ledger's answer for one account, or null when it is not that shape for the account asked for. */
export function parseAccountMetadata(raw: unknown, accountId: string): AccountMetadata | null {
  if (!isRecord(raw) || raw.accountId !== accountId || !isText(raw.address) || typeof raw.frozen !== 'boolean') return null;
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.deleted) || !Array.isArray(raw.changes)) return null;
  const entries = raw.entries.map(parseEntry);
  const changes = raw.changes.map(parseMetadataChange);
  const deleted = raw.deleted.map((d) =>
    isRecord(d) && isText(d.key) && isRevision(d.revision) ? { key: d.key, revision: d.revision } : null,
  );
  if (entries.includes(null) || changes.includes(null) || deleted.includes(null)) return null;
  return {
    accountId,
    address: raw.address,
    entries: entries as MetadataEntry[],
    deleted: deleted as { key: string; revision: number }[],
    changes: changes as MetadataChange[],
    frozen: raw.frozen,
  };
}

/** svc-ledger's answer to a write: the change it recorded on this account. */
export function parseMetadataWrite(raw: unknown, accountId: string): MetadataChange | null {
  if (!isRecord(raw) || raw.accountId !== accountId) return null;
  return parseMetadataChange(raw.change);
}

export interface MetadataSetBody {
  readonly key: string;
  readonly value: string;
  readonly reason: string;
  readonly revision: number;
}

/** The set body exactly as svc-ledger takes it, or null for one it would refuse. */
export function metadataSetBody(raw: unknown): MetadataSetBody | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'key,reason,revision,value') return null;
  const { key, value, reason, revision } = raw;
  if (!isText(key) || !METADATA_KEY.test(key) || !isRevision(revision)) return null;
  if (!isText(value) || value.length < 1 || value.length > METADATA_VALUE_MAX) return null;
  if (!isText(reason) || reason.trim() !== reason || reason.length < 12 || reason.length > 500) return null;
  return { key, value, reason, revision };
}

/** The revision a set of this key starts from: the value's, a deleted key's, or 0 for a key never set. */
export function revisionOf(metadata: AccountMetadata, key: string): number {
  return metadata.entries.find((e) => e.key === key)?.revision ?? metadata.deleted.find((d) => d.key === key)?.revision ?? 0;
}
