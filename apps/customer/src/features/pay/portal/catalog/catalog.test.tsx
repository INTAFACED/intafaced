import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { MerchantAccessContext } from '../access/MerchantAccess';
import { allows, type Access } from '../access/resolve';
import { ROLE_CAPABILITIES } from '../access/capabilities';
import type { PortalApi } from '../api';
import { parsePortalRoute } from '../routes';
import { ProductCreate } from './Products';
import { productImageUploadInputSchema } from '@intafaced/contracts/merchant-catalog';
import {
  blankPrice,
  blankProduct,
  checkImage,
  draftProblem,
  imageRequestId,
  priceBody,
  priceProblem,
  productBody,
  sizeText,
} from './model';

// TEST data only: nobody here is real.
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const ready = (role: 'owner' | 'admin' | 'developer' | 'finance' | 'viewer', kybStatus = 'approved') =>
  ({
    status: 'ready',
    source: 'my-access',
    merchantId: MERCHANT,
    role,
    accountStatus: 'active',
    kybStatus,
    mode: 'gateway',
    sessionInteractive: true,
    displayName: null,
    legalName: null,
    pricingVisibility: null,
    capabilities: ROLE_CAPABILITIES[role],
  }) as Access;
const pending = new Promise<never>(() => undefined);
const portal = { productImageRules: () => pending } as unknown as PortalApi;
const draw = (access: Access) =>
  renderToStaticMarkup(
    <MerchantAccessContext.Provider value={{ access, can: (need: Parameters<typeof allows>[1]) => allows(access, need) } as never}>
      <ProductCreate portal={portal} />
    </MerchantAccessContext.Provider>,
  );

describe('product catalogue (J-merchant-03 steps 1 and 2)', () => {
  it('opens /pay/products, /pay/products/new and one product at their own addresses', () => {
    expect(parsePortalRoute('/pay/products')).toEqual({ room: 'products' });
    expect(parsePortalRoute('/pay/products/new')).toEqual({ room: 'product-new' });
    expect(parsePortalRoute('/pay/products/c1000001-0000-4000-8000-000000000001')).toEqual({
      room: 'product',
      param: 'c1000001-0000-4000-8000-000000000001',
    });
  });
  it('gives the owner, admins and developers the form, and finance and viewers no way to add', () => {
    for (const role of ['owner', 'admin', 'developer'] as const) {
      const page = draw(ready(role));
      expect(page, role).toContain('Save product');
      expect(page, role).toContain('Name *');
      expect(page, role).not.toContain('Start time *');
    }
    for (const role of ['finance', 'viewer'] as const) {
      const page = draw(ready(role));
      expect(page, role).not.toContain('Save product');
      expect(page, role).toContain('The owner, an admin or a developer can add them.');
    }
    expect(draw(ready('owner', 'pending'))).toContain('Products can be added once your business is verified.');
  });
  it('keeps Save off while the name is empty, and asks an event for its time and place', () => {
    expect(draftProblem(blankProduct())).toBe('nameRequired');
    const named = { ...blankProduct(), name: 'TEST Workshop' };
    expect(draftProblem(named)).toBeNull();
    expect(draftProblem({ ...named, type: 'event' })).toBe('eventInvalid');
    expect(draftProblem({ ...named, type: 'event', eventStartsAt: '2026-12-01T18:00', eventLocation: 'TEST Hall' })).toBeNull();
    expect(draftProblem({ ...named, productKey: 'Has Spaces' })).toBe('keyInvalid');
    expect(draftProblem({ ...named, statementDescriptor: 'TEST*SHOP' })).toBe('descriptorInvalid');
  });
  it('sends only what was filled in, and an event time only for an event', () => {
    const body = productBody(
      { ...blankProduct(), name: ' TEST Tee ', type: 'digital', eventStartsAt: '2026-12-01T18:00', eventLocation: 'x' },
      'r1',
    );
    expect(body).toEqual({ requestId: 'r1', name: 'TEST Tee', type: 'digital' });
    const event = productBody(
      { ...blankProduct(), name: 'TEST Gig', type: 'event', eventStartsAt: '2026-12-01T18:00', eventLocation: ' TEST Hall ' },
      'r2',
    );
    expect(event.event).toEqual({ startsAt: new Date('2026-12-01T18:00').toISOString(), location: 'TEST Hall' });
  });
  it('refuses a 3 MB image and a GIF with the rule before anything is sent', () => {
    const rules = { maxBytes: 500_000, types: ['image/png' as const, 'image/jpeg' as const, 'image/webp' as const] };
    expect(checkImage({ size: 3_000_000, type: 'image/png' }, rules)).toEqual({
      ok: false,
      reason: 'tooLarge',
      size: 3_000_000,
      max: 500_000,
    });
    expect(checkImage({ size: 1000, type: 'image/gif' }, rules)).toMatchObject({ ok: false, reason: 'wrongType' });
    expect(checkImage({ size: 1000, type: 'image/webp' }, rules)).toEqual({ ok: true });
    expect(checkImage({ size: 1000, type: 'image/png' }, { ...rules, maxBytes: null })).toEqual({ ok: false, reason: 'rulesUnset' });
    expect([sizeText(512), sizeText(500_000), sizeText(3_000_000)]).toEqual(['512 bytes', '500 KB', '3 MB']);
  });

  it('names an upload by its file, so the same file sent again is the same request', async () => {
    const one = await imageRequestId(new Blob([new Uint8Array([1, 2, 3])]));
    expect(await imageRequestId(new Blob([new Uint8Array([1, 2, 3])]))).toBe(one);
    expect(await imageRequestId(new Blob([new Uint8Array([1, 2, 4])]))).not.toBe(one);
    expect(productImageUploadInputSchema.safeParse({ requestId: one, contentType: 'image/png', dataBase64: 'AQID' }).success).toBe(true);
  });

  it('checks a price before it is sent, and sends a monthly price as a fixed amount', () => {
    const fixed = { ...blankPrice, amount: '20', assetId: 'USDC' };
    expect(priceProblem(fixed)).toBeNull();
    expect(priceProblem({ ...fixed, amount: '0' })).toBe('amountInvalid');
    expect(priceProblem({ ...fixed, amount: '1e3' })).toBe('amountInvalid');
    expect(priceProblem({ ...fixed, assetId: 'usdc' })).toBe('assetInvalid');
    const chosen = { ...blankPrice, kind: 'customer_chosen' as const, minAmount: '5', maxAmount: '100', assetId: 'USDC' };
    expect(priceProblem(chosen)).toBeNull();
    expect(priceProblem({ ...chosen, maxAmount: '4.99' })).toBe('boundsInvalid');
    expect(priceProblem({ ...chosen, maxAmount: '' })).toBe('boundsInvalid');
    expect(priceBody(chosen, 'p1')).toEqual({
      productId: 'p1',
      billing: 'one_time',
      kind: 'customer_chosen',
      assetId: 'USDC',
      minAmount: '5',
      maxAmount: '100',
    });
    expect(priceBody({ ...chosen, billing: 'monthly', amount: '9' }, 'p1')).toEqual({
      productId: 'p1',
      billing: 'monthly',
      kind: 'fixed',
      assetId: 'USDC',
      amount: '9',
    });
  });
});
