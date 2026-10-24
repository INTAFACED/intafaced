/**
 * The owner's rule for product images (M-catalogue-01, J-merchant-03 step 2): the largest file a business may upload,
 * in bytes. Blank means no size is published, and every image upload refuses `pay.product_image_rules_unset`; a
 * product can still be made without an image. Never a guessed default.
 */
export const PRODUCT_IMAGE_MAX_BYTES_ENV = 'PAY_PRODUCT_IMAGE_MAX_BYTES';

export interface ProductImageRule {
  readonly maxBytes: number | null;
}

/** A whole number of bytes from 1 to 10 000 000, or blank. Anything else refuses to boot. */
export function readProductImageRule(env: Record<string, string | undefined>): ProductImageRule {
  const raw = env[PRODUCT_IMAGE_MAX_BYTES_ENV]?.trim() ?? '';
  if (!raw) return { maxBytes: null };
  if (!/^[1-9][0-9]{0,7}$/.test(raw) || Number(raw) > 10_000_000) {
    throw new Error(`${PRODUCT_IMAGE_MAX_BYTES_ENV} must be a whole number of bytes from 1 to 10000000. Refusing to boot.`);
  }
  return { maxBytes: Number(raw) };
}
