/**
 * The owner's rule for product images (M-catalogue-01, J-merchant-03 step 2): the largest file a business may upload,
 * in bytes. Blank means no size is published, and every image upload refuses `pay.product_image_rules_unset`; a
 * product can still be made without an image. Never a guessed default.
 */
export const PRODUCT_IMAGE_MAX_BYTES_ENV = 'PAY_PRODUCT_IMAGE_MAX_BYTES';

export interface ProductImageRule {
  readonly maxBytes: number | null;
}

/**
 * The largest rule a request can carry. An upload travels as base64 inside one JSON request, and both the front door
 * (EDGE_BODY_LIMIT_BYTES, 1 MiB on the stack) and svc-pay (Fastify's 1 MiB default) stop larger bodies with a bare 413.
 * 700 000 bytes is 933 336 base64 characters, which leaves room for the envelope under 1 MiB.
 */
export const PRODUCT_IMAGE_MAX_BYTES_CEILING = 700_000;

/** A whole number of bytes from 1 to the ceiling, or blank. Anything else refuses to boot. */
export function readProductImageRule(env: Record<string, string | undefined>): ProductImageRule {
  return readImageByteRule(env, PRODUCT_IMAGE_MAX_BYTES_ENV, PRODUCT_IMAGE_MAX_BYTES_CEILING);
}

/**
 * An owner's image size rule from `name`: a whole number of bytes from 1 to `ceiling`, or blank for no published size.
 * Anything else refuses to boot, naming the variable. Product images and checkout logos read theirs with it.
 */
export function readImageByteRule(env: Record<string, string | undefined>, name: string, ceiling: number): { maxBytes: number | null } {
  const raw = env[name]?.trim() ?? '';
  if (!raw) return { maxBytes: null };
  if (!/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) > ceiling) {
    throw new Error(`${name} must be a whole number of bytes from 1 to ${ceiling}. Refusing to boot.`);
  }
  return { maxBytes: Number(raw) };
}
