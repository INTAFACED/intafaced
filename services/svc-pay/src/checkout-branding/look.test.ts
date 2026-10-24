import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { brandLook, registerCheckoutRoutes, renderCheckoutPage, type CheckoutLinkView, type CheckoutPay } from '../checkout-page.js';
import { readCheckoutLogoRule } from './logo-rules.js';
import { checkoutLookOf } from './branding.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const link: CheckoutLinkView = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  merchantId: '11111111-1111-4111-8111-111111111111',
  profileId: null,
  label: 'TEST Hoodie',
  amount: '25',
  currency: 'USDC',
  checkoutConfig: {},
  token: 'TEST-token-abc12345',
};

describe('the hosted checkout look (M-payments-core-08, J-merchant-04 step 1)', () => {
  it('reads the logo rule as a whole number up to the ceiling, blank as no rule, and refuses anything else', () => {
    expect(readCheckoutLogoRule({})).toEqual({ maxBytes: null });
    expect(readCheckoutLogoRule({ PAY_CHECKOUT_LOGO_MAX_BYTES: ' ' })).toEqual({ maxBytes: null });
    expect(readCheckoutLogoRule({ PAY_CHECKOUT_LOGO_MAX_BYTES: '100000' })).toEqual({ maxBytes: 100_000 });
    for (const bad of ['0', '-1', '1.5', '200001', 'abc', '1e5'])
      expect(() => readCheckoutLogoRule({ PAY_CHECKOUT_LOGO_MAX_BYTES: bad })).toThrow(/PAY_CHECKOUT_LOGO_MAX_BYTES/);
  });

  it('shows the saved colour and logo on the payer page, and the default page without one', () => {
    const plain = renderCheckoutPage({ kind: 'ok', link });
    expect(plain.html).not.toContain('--on-accent:');
    expect(plain.html).not.toContain('class="logo"');

    const look = { brandColor: '#ff6600', logo: { contentType: 'image/png', dataBase64: PNG } };
    const branded = renderCheckoutPage({ kind: 'ok', link }, undefined, look);
    expect(branded.html).toContain('<main style="--accent: #ff6600; --on-accent: #101820">');
    expect(branded.html).toContain(`<img class="logo" src="data:image/png;base64,${PNG}" alt="Merchant logo" />`);
    // The session page after Continue keeps the look; a page for a link that opens nothing has none.
    const session = renderCheckoutPage(
      {
        kind: 'session',
        session: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
          status: 'open',
          label: 'TEST Hoodie',
          amount: '25',
          currency: 'USDC',
          method: 'crypto',
          expiresAt: '2026-10-24T20:00:00.000Z',
          instruction: null,
        },
      },
      undefined,
      look,
    );
    expect(session.html).toContain('--accent: #ff6600');
    expect(session.html).toContain('class="logo"');
    expect(renderCheckoutPage({ kind: 'not_found' }).html).not.toContain('--on-accent:');
  });

  it('picks button text that reads on the colour, as the portal preview does', () => {
    expect(brandLook({ brandColor: '#0b1f3a', logo: null }).style).toContain('--on-accent: #ffffff');
    expect(brandLook({ brandColor: '#ffee00', logo: null }).style).toContain('--on-accent: #101820');
  });

  it('leaves out anything unchecked rather than write it into the page', () => {
    expect(brandLook({ brandColor: 'red; background: url(x)', logo: null })).toEqual({ style: '', logo: '' });
    expect(brandLook({ brandColor: '#FF6600', logo: null })).toEqual({ style: '', logo: '' });
    expect(brandLook({ brandColor: '#ff6600', logo: { contentType: 'image/svg+xml', dataBase64: PNG } }).logo).toBe('');
    expect(brandLook({ brandColor: '#ff6600', logo: { contentType: 'image/png', dataBase64: '" onerror="x' } }).logo).toBe('');
    expect(checkoutLookOf({ brand_color: null, logo_type: null, logo_bytes: null })).toBeNull();
    expect(checkoutLookOf({ brand_color: 'blue', logo_type: null, logo_bytes: null })).toBeNull();
    expect(checkoutLookOf({ brand_color: '#123456', logo_type: 'image/gif', logo_bytes: Buffer.from([1]) })).toEqual({
      brandColor: '#123456',
      logo: null,
    });
  });

  it('asks for the look of the token the payer holds, and shows the page with its own colours when that read fails', async () => {
    const asked: unknown[] = [];
    const build = async (checkoutLook: CheckoutPay['checkoutLook']) => {
      const app = Fastify();
      await registerCheckoutRoutes(app, {
        resolvePaymentLink: async () => link,
        openCheckoutSession: async () => {
          throw new Error('not used');
        },
        getCheckoutSession: async () => {
          throw new Error('not used');
        },
        checkoutLook,
      });
      await app.ready();
      return app;
    };
    const app = await build(async (ref) => {
      asked.push(ref);
      return { brandColor: '#ff6600', logo: null };
    });
    const res = await app.inject({ method: 'GET', url: '/checkout?token=TEST-token-abc12345' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('--accent: #ff6600');
    expect(asked).toEqual([{ linkToken: 'TEST-token-abc12345' }]);
    await app.close();

    const failing = await build(async () => {
      throw new Error('TEST read failed');
    });
    const plain = await failing.inject({ method: 'GET', url: '/checkout?token=TEST-token-abc12345' });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toContain('TEST Hoodie');
    expect(plain.body).not.toContain('--on-accent:');
    await failing.close();
  });
});
