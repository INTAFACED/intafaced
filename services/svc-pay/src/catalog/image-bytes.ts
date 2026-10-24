import { createHash } from 'node:crypto';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { PRODUCT_IMAGE_TYPES } from '@intafaced/contracts';

type ImageType = (typeof PRODUCT_IMAGE_TYPES)[number];

/** Which of the allowed image types these bytes are, from their first bytes; null for anything else (a GIF included). */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The refusals one kind of upload answers with, in its own words (a product image, a checkout logo). */
export interface ImageUploadCodes {
  readonly tooLarge: `pay.${string}`;
  readonly unreadable: `pay.${string}`;
  readonly typeRefused: `pay.${string}`;
}

/**
 * An uploaded image checked against a published size: refused over `maxBytes` (before it is decoded, and again after),
 * when it is not plain base64 or empty, and unless its own first bytes are a PNG, JPEG or WebP and the type it claims.
 * Product images (M-catalogue-01) and checkout logos (M-payments-core-08) share it, so one check guards both.
 */
export function decodeImageUpload(maxBytes: number, input: { contentType: string; dataBase64: string }, codes: ImageUploadCodes) {
  if (Math.floor((input.dataBase64.length * 3) / 4) - 2 > maxBytes) throw new MerchantOpsError(codes.tooLarge, 'bad_request');
  if (!BASE64.test(input.dataBase64)) throw new MerchantOpsError(codes.unreadable, 'bad_request');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw new MerchantOpsError(codes.unreadable, 'bad_request');
  if (bytes.length > maxBytes) throw new MerchantOpsError(codes.tooLarge, 'bad_request');
  const type = sniffImageType(bytes);
  if (!type || type !== input.contentType.toLowerCase()) throw new MerchantOpsError(codes.typeRefused, 'bad_request');
  return { bytes, type, sha256: createHash('sha256').update(bytes).digest('hex') };
}
