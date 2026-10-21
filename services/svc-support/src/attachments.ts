/**
 * Attachment upload port. Production boots with neither adapter set.
 * Bytes stay in the store the caller supplies. This module holds no file
 * and no default size or type list.
 */

export const ATTACHMENT_STORE_KEY = 'support.attachment_store';
export const ATTACHMENT_SCANNER_KEY = 'support.malware_scanner';
export const ATTACHMENT_MAX_BYTES_KEY = 'support.attachment_max_bytes';
export const ATTACHMENT_ALLOWED_TYPES_KEY = 'support.attachment_allowed_types';
export const ATTACHMENT_MAX_COUNT_KEY = 'support.attachment_max_count';

export type ScanVerdict = 'clean' | 'infected' | 'unknown';

export interface AttachmentStore {
  put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Removes an object. A key that is not there is not an error. */
  delete(key: string): Promise<void>;
}

export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

/** Blank means the desk has not been given that piece. Null is blank. */
export type AttachmentDesk = {
  readonly store: AttachmentStore | null;
  readonly scanner: MalwareScanner | null;
  readonly maxBytes: number | null;
  readonly allowedTypes: readonly string[] | null;
  /** Files one request may hold. Absent or null is blank. A deployment leaves it to the owner's settings. */
  readonly maxCount?: number | null;
};

export const UNCONFIGURED_ATTACHMENTS: AttachmentDesk = {
  store: null,
  scanner: null,
  maxBytes: null,
  allowedTypes: null,
  maxCount: null,
};

/**
 * First missing piece, in the order the write needs them.
 * A non-integer, a non-positive size, or an empty type list is blank.
 */
export function missingAttachmentKey(desk: AttachmentDesk): string | null {
  if (desk.store == null) return ATTACHMENT_STORE_KEY;
  if (desk.scanner == null) return ATTACHMENT_SCANNER_KEY;
  if (desk.maxBytes == null || !Number.isInteger(desk.maxBytes) || desk.maxBytes < 1) return ATTACHMENT_MAX_BYTES_KEY;
  if (desk.allowedTypes == null || desk.allowedTypes.length === 0) return ATTACHMENT_ALLOWED_TYPES_KEY;
  return null;
}

export class MemoryAttachmentStore implements AttachmentStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  puts = 0;

  async put(input: { key: string; bytes: Uint8Array; contentType: string }): Promise<void> {
    this.puts += 1;
    this.objects.set(input.key, { bytes: input.bytes, contentType: input.contentType });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const hit = this.objects.get(key);
    return hit ? { bytes: hit.bytes, contentType: hit.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export class MemoryMalwareScanner implements MalwareScanner {
  constructor(private readonly verdict: ScanVerdict | ((bytes: Uint8Array) => ScanVerdict) = 'clean') {}

  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return typeof this.verdict === 'function' ? this.verdict(bytes) : this.verdict;
  }
}

/** Invalid base64 is null. An empty string is an empty body, not a guess. */
export function decodeAttachmentBody(bodyBase64: string): Uint8Array | null {
  if (bodyBase64.length === 0) return new Uint8Array();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bodyBase64) || bodyBase64.length % 4 === 1) return null;
  const buf = Buffer.from(bodyBase64, 'base64');
  const round = buf.toString('base64').replace(/=+$/, '');
  const given = bodyBase64.replace(/=+$/, '');
  if (round !== given) return null;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
