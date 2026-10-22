import { describe, expect, it } from 'vitest';
import { PayError } from '../payment-service.js';
import { assertCollectionMethodAvailable, collectionMethodOf } from './merchant-disp-bill-rep-collection-method.js';

describe('M-bill-01 collection method (pure)', () => {
  it('names the existing path the merchant way', () => {
    expect(collectionMethodOf('crypto_invoice')).toBe('send_invoice');
    expect(collectionMethodOf('card')).toBe('charge_automatically');
    expect(collectionMethodOf('card_mandate')).toBe('charge_automatically');
  });

  it('an unknown path refuses instead of guessing a method', () => {
    expect(() => collectionMethodOf('bank_pull')).toThrow(PayError);
  });

  it('charge automatically refuses rail absent; send invoice passes', () => {
    expect(() => assertCollectionMethodAvailable('charge_automatically')).toThrow(
      expect.objectContaining({ code: 'pay.mandate_rail_absent', blockers: [{ code: 'rail.card' }] }),
    );
    expect(() => assertCollectionMethodAvailable('send_invoice')).not.toThrow();
  });
});
