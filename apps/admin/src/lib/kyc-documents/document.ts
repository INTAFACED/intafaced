/**
 * A KYC document identity opened for one founder (`kyc.getDocument`, J-ops-console-02 #5), and how the console shows it.
 *
 * Identity serves a document's contents only through its two-founder door and spends the approval on the read. The console
 * holds the contents in the page that asked, for as long as the viewer is open, and never stores, caches or logs them.
 * Pure: the server reads identity's answer with it, and the browser reads the console's answer with it.
 */

/** Identity's own cap on a stored document (10 MiB decoded, `document-store.ts`). */
export const KYC_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The types the viewer draws on the page. An image element never runs what it shows; anything else is offered as a file. */
export const VIEWABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export interface OpenedDocument {
  readonly id: string;
  readonly userId: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly storedBy: string | null;
  readonly createdAt: string;
  readonly bytesBase64: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTENT_TYPE = /^[\x21-\x7e][\x20-\x7e]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** How many bytes a canonical base64 string decodes to. */
export function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** Strict reader: exactly identity's answer, with contents that decode to the length identity states, or null. */
export function readOpenedDocument(raw: unknown): OpenedDocument | null {
  if (!isRecord(raw)) return null;
  const { id, userId, contentType, byteLength, storedBy, createdAt, bytesBase64 } = raw;
  if (typeof id !== 'string' || !UUID.test(id) || typeof userId !== 'string' || !UUID.test(userId)) return null;
  if (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType)) return null;
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > KYC_DOCUMENT_MAX_BYTES) return null;
  if (!(storedBy === null || typeof storedBy === 'string') || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)))
    return null;
  if (typeof bytesBase64 !== 'string' || !BASE64.test(bytesBase64) || decodedLength(bytesBase64) !== byteLength) return null;
  return { id, userId, contentType, byteLength, storedBy, createdAt, bytesBase64 };
}

/** The media type alone, lower case: `image/PNG; x=1` is `image/png`. */
export function mediaType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/** True when the viewer draws this document on the page; otherwise it is offered as a file to save. */
export function viewableImage(document: Pick<OpenedDocument, 'contentType'>): boolean {
  return (VIEWABLE_IMAGE_TYPES as readonly string[]).includes(mediaType(document.contentType));
}

/** The name a saved document gets: its id and an extension from its type, never a name the uploader chose. */
export function savedName(document: Pick<OpenedDocument, 'id' | 'contentType'>): string {
  const type = mediaType(document.contentType);
  const ext =
    type === 'application/pdf'
      ? 'pdf'
      : type === 'image/png'
        ? 'png'
        : type === 'image/jpeg'
          ? 'jpg'
          : type === 'image/webp'
            ? 'webp'
            : type === 'image/gif'
              ? 'gif'
              : 'bin';
  return `kyc-document-${document.id}.${ext}`;
}
