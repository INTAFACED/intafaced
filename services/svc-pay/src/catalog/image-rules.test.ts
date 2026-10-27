import { describe, expect, it } from 'vitest';
import { PRODUCT_IMAGE_MAX_BYTES_CEILING, readProductImageRule } from './image-rules.js';

describe('product image rule (PAY_PRODUCT_IMAGE_MAX_BYTES)', () => {
  it('is blank until the owner sets it, and takes a whole number up to what one request carries', () => {
    expect(readProductImageRule({})).toEqual({ maxBytes: null });
    expect(readProductImageRule({ PAY_PRODUCT_IMAGE_MAX_BYTES: ' ' })).toEqual({ maxBytes: null });
    expect(readProductImageRule({ PAY_PRODUCT_IMAGE_MAX_BYTES: '500000' })).toEqual({ maxBytes: 500_000 });
    expect(readProductImageRule({ PAY_PRODUCT_IMAGE_MAX_BYTES: String(PRODUCT_IMAGE_MAX_BYTES_CEILING) })).toEqual({
      maxBytes: PRODUCT_IMAGE_MAX_BYTES_CEILING,
    });
  });

  it('refuses to boot on a size no request could carry, or anything that is not a whole number of bytes', () => {
    // 700 000 bytes is 933 336 base64 characters: a larger file would meet a bare 413 at the 1 MiB body limit.
    expect(Math.ceil(PRODUCT_IMAGE_MAX_BYTES_CEILING / 3) * 4).toBeLessThan(1_048_576 - 10_000);
    for (const raw of ['700001', '10000000', '0', '-5', '1.5', '5e5', 'lots']) {
      expect(() => readProductImageRule({ PAY_PRODUCT_IMAGE_MAX_BYTES: raw })).toThrow(/Refusing to boot/);
    }
  });
});
