import type { SupportAttachmentKey } from '@intafaced/contracts';

/**
 * The attachment limits and the state of the five pieces an attach needs, as svc-support returns them
 * (`attachmentStatus`), and the form's pure rules. Hand-written strict readers: a shape that is not exactly this makes the
 * whole read invalid, so the desk never prints a guess. The contracts package is imported for its types only; the key list
 * and the media type rule are repeated here and `attachments.test.ts` pins both to the contract.
 */

export const ATTACHMENT_SETTINGS = ['maxBytes', 'allowedTypes', 'maxCount'] as const;
export type AttachmentSetting = (typeof ATTACHMENT_SETTINGS)[number];

export const ATTACHMENT_KEYS: readonly SupportAttachmentKey[] = [
  'support.attachment_store',
  'support.malware_scanner',
  'support.attachment_max_bytes',
  'support.attachment_allowed_types',
  'support.attachment_max_count',
];

export const ATTACHMENT_PIECE_LABEL: Readonly<Record<SupportAttachmentKey, string>> = {
  'support.attachment_store': 'File store',
  'support.malware_scanner': 'Malware scanner',
  'support.attachment_max_bytes': 'Largest file',
  'support.attachment_allowed_types': 'Allowed file types',
  'support.attachment_max_count': 'Files per request',
};

export const ATTACHMENT_PIECE_WHERE: Readonly<Record<SupportAttachmentKey, string>> = {
  'support.attachment_store': 'Set in the deployment, not here.',
  'support.malware_scanner': 'Set in the deployment, not here.',
  'support.attachment_max_bytes': 'Set below.',
  'support.attachment_allowed_types': 'Set below.',
  'support.attachment_max_count': 'Set below.',
};

export const ATTACHMENT_LABEL: Readonly<Record<AttachmentSetting, string>> = {
  maxBytes: 'Largest file, in bytes',
  allowedTypes: 'Allowed file types',
  maxCount: 'Files per request',
};

export const ATTACHMENT_HINT: Readonly<Record<AttachmentSetting, string>> = {
  maxBytes: 'A whole number of bytes. A customer is told this limit before they attach.',
  allowedTypes: 'One media type per line or separated by commas, for example image/png. No wildcards, no parameters.',
  maxCount: 'A whole number. Files a scan blocked do not count.',
};

export const REASON_MAX = 500;
const TYPES_MAX = 50;
const INT_MAX = 2_147_483_646;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export interface AttachmentLimits {
  readonly maxBytes: number | null;
  readonly allowedTypes: readonly string[] | null;
  readonly maxCount: number | null;
  readonly missing: SupportAttachmentKey | null;
  readonly revision: number;
  readonly updatedAt: string | null;
}

export interface AttachmentPiece {
  readonly key: SupportAttachmentKey;
  readonly set: boolean;
}

export interface AttachmentStatus {
  readonly pieces: readonly AttachmentPiece[];
  readonly limits: AttachmentLimits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const isKey = (v: unknown): v is SupportAttachmentKey => typeof v === 'string' && (ATTACHMENT_KEYS as readonly string[]).includes(v);
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= INT_MAX;

export function readAttachmentLimits(raw: unknown): AttachmentLimits | null {
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).sort().join(',') !== 'allowedTypes,maxBytes,maxCount,missing,revision,updatedAt') return null;
  const { maxBytes, allowedTypes, maxCount, missing, revision, updatedAt } = raw;
  if (!(maxBytes === null || positiveInt(maxBytes))) return null;
  if (!(maxCount === null || positiveInt(maxCount))) return null;
  if (!(
    allowedTypes === null ||
    (Array.isArray(allowedTypes) &&
      allowedTypes.length >= 1 &&
      allowedTypes.length <= TYPES_MAX &&
      allowedTypes.every((t) => typeof t === 'string' && MEDIA_TYPE.test(t)) &&
      new Set(allowedTypes).size === allowedTypes.length)
  ))
    return null;
  if (!(missing === null || isKey(missing))) return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  if (!(updatedAt === null || (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))))) return null;
  return { maxBytes, allowedTypes: allowedTypes as readonly string[] | null, maxCount, missing, revision, updatedAt };
}

export function readAttachmentStatus(raw: unknown): AttachmentStatus | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'limits,pieces') return null;
  const limits = readAttachmentLimits(raw.limits);
  if (!limits || !Array.isArray(raw.pieces) || raw.pieces.length !== ATTACHMENT_KEYS.length) return null;
  const pieces: AttachmentPiece[] = [];
  for (let i = 0; i < ATTACHMENT_KEYS.length; i += 1) {
    const p: unknown = raw.pieces[i];
    if (!isRecord(p) || Object.keys(p).sort().join(',') !== 'key,set') return null;
    if (p.key !== ATTACHMENT_KEYS[i] || typeof p.set !== 'boolean') return null;
    pieces.push({ key: ATTACHMENT_KEYS[i]!, set: p.set });
  }
  return { pieces, limits };
}

export type AttachmentDrafts = Readonly<Record<AttachmentSetting, string>>;

export const emptyAttachmentDrafts: AttachmentDrafts = { maxBytes: '', allowedTypes: '', maxCount: '' };

/** The form starts from what is stored; a limit that is not set starts empty. */
export function attachmentDraftsFrom(current: AttachmentLimits): AttachmentDrafts {
  return {
    maxBytes: current.maxBytes === null ? '' : String(current.maxBytes),
    allowedTypes: current.allowedTypes === null ? '' : current.allowedTypes.join('\n'),
    maxCount: current.maxCount === null ? '' : String(current.maxCount),
  };
}

export type AttachmentChanges = {
  maxBytes?: number | null;
  allowedTypes?: string[] | null;
  maxCount?: number | null;
};

export type AttachmentParse =
  { readonly ok: true; readonly changes: AttachmentChanges | null } | { readonly ok: false; readonly why: string };

function parseWhole(text: string, label: string): { ok: true; value: number | null } | { ok: false; why: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^[0-9]+$/.test(t)) return { ok: false, why: `${label} must be a whole number.` };
  const n = Number(t);
  if (!positiveInt(n)) return { ok: false, why: `${label} must be at least 1 and not above ${INT_MAX}.` };
  return { ok: true, value: n };
}

export function parseTypeList(text: string): { ok: true; value: string[] | null } | { ok: false; why: string } {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return { ok: true, value: null };
  if (parts.length > TYPES_MAX) return { ok: false, why: `List at most ${TYPES_MAX} file types.` };
  for (const p of parts) if (!MEDIA_TYPE.test(p)) return { ok: false, why: `"${p}" is not a media type such as image/png.` };
  if (new Set(parts).size !== parts.length) return { ok: false, why: 'A file type is listed twice.' };
  return { ok: true, value: parts };
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * What the form changes: a field left alone is left out, a field emptied that was set is cleared (`null`), a field that
 * differs is set. `changes` is `null` when nothing differs, so a save with no change is never sent. A value that cannot
 * be read says why and nothing is sent.
 */
export function attachmentChanges(current: AttachmentLimits, drafts: AttachmentDrafts): AttachmentParse {
  const bytes = parseWhole(drafts.maxBytes, ATTACHMENT_LABEL.maxBytes);
  if (!bytes.ok) return bytes;
  const count = parseWhole(drafts.maxCount, ATTACHMENT_LABEL.maxCount);
  if (!count.ok) return count;
  const types = parseTypeList(drafts.allowedTypes);
  if (!types.ok) return types;
  const out: AttachmentChanges = {};
  if (bytes.value !== current.maxBytes) out.maxBytes = bytes.value;
  if (count.value !== current.maxCount) out.maxCount = count.value;
  if (!sameList(types.value, current.allowedTypes)) out.allowedTypes = types.value;
  return { ok: true, changes: Object.keys(out).length === 0 ? null : out };
}

export type AttachmentGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

export function attachmentGate(current: AttachmentLimits, drafts: AttachmentDrafts, reason: string, busy: boolean): AttachmentGate {
  if (busy) return { ok: false, why: 'Sending.' };
  const parsed = attachmentChanges(current, drafts);
  if (!parsed.ok) return parsed;
  if (parsed.changes === null) return { ok: false, why: 'Nothing has changed.' };
  const text = reason.trim();
  if (text === '') return { ok: false, why: 'Say why you are changing it.' };
  if (text.length > REASON_MAX) return { ok: false, why: `Keep the reason to ${REASON_MAX} characters.` };
  return { ok: true };
}

/** The request the BFF takes from the page. The revision is the one the page read. */
export interface AttachmentSetRequest {
  readonly changes: AttachmentChanges;
  readonly expectedRevision: number;
  readonly reason: string;
}

export function readAttachmentSetRequest(raw: Record<string, unknown>): AttachmentSetRequest | null {
  const { changes, expectedRevision, reason } = raw;
  if (!isRecord(changes) || typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)
    return null;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > REASON_MAX) return null;
  const out: AttachmentChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'maxBytes' || key === 'maxCount') {
      if (!(value === null || positiveInt(value))) return null;
      out[key] = value;
    } else if (key === 'allowedTypes') {
      if (value === null) out.allowedTypes = null;
      else {
        if (!Array.isArray(value) || value.length < 1 || value.length > TYPES_MAX) return null;
        if (!value.every((t) => typeof t === 'string' && MEDIA_TYPE.test(t)) || new Set(value).size !== value.length) return null;
        out.allowedTypes = value as string[];
      }
    } else return null;
  }
  return Object.keys(out).length === 0 ? null : { changes: out, expectedRevision, reason: reason.trim() };
}
