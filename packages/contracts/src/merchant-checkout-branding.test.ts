import { describe, expect, it } from 'vitest';
import { checkoutBrandingSaveInputSchema, checkoutButtonTextColor } from './merchant-checkout-branding.js';

const requestId = '11111111-1111-4111-8111-111111111111';

describe('merchantCheckout.branding (M-payments-core-08)', () => {
  it('keeps a brand colour in lower case and refuses anything that is not # and six hex digits', () => {
    expect(checkoutBrandingSaveInputSchema.parse({ requestId, expectedVersion: 0, brandColor: ' #FF6600 ' }).brandColor).toBe('#ff6600');
    for (const brandColor of ['ff6600', '#ff660', '#ff66000', 'orange', '#gg6600', 'red; background: url(x)'])
      expect(checkoutBrandingSaveInputSchema.safeParse({ requestId, expectedVersion: 0, brandColor }).success).toBe(false);
  });

  it('tells a kept logo (left out) from a removed one (null) and a new one', () => {
    const base = { requestId, expectedVersion: 1, brandColor: '#123456' };
    expect(checkoutBrandingSaveInputSchema.parse(base)).not.toHaveProperty('logo');
    expect(checkoutBrandingSaveInputSchema.parse({ ...base, logo: null }).logo).toBeNull();
    expect(checkoutBrandingSaveInputSchema.parse({ ...base, logo: { contentType: 'image/png', dataBase64: 'iVBO' } }).logo).toEqual({
      contentType: 'image/png',
      dataBase64: 'iVBO',
    });
    expect(checkoutBrandingSaveInputSchema.safeParse({ ...base, expectedVersion: -1 }).success).toBe(false);
  });

  it('picks button text that reads on the colour: dark on a light one, white on a dark one', () => {
    expect(checkoutButtonTextColor('#ff6600')).toBe('#101820');
    expect(checkoutButtonTextColor('#ffee00')).toBe('#101820');
    expect(checkoutButtonTextColor('#1a5fd0')).toBe('#ffffff');
    expect(checkoutButtonTextColor('#0b1f3a')).toBe('#ffffff');
  });
});
