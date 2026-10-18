import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoFee } from './section-panels';

const text = (status: string) => renderToStaticMarkup(<NoFee status={status} />);

describe('payment without a pricing snapshot', () => {
  it('says the snapshot comes at capture before capture', () => {
    for (const status of ['created', 'authorized']) expect(text(status)).toContain('Recorded at capture');
  });

  it('says no pricing rule applied once the payment was captured', () => {
    for (const status of ['captured', 'settled', 'refunded', 'disputed']) {
      expect(text(status)).toContain('Not recorded: no pricing rule at capture');
      expect(text(status)).not.toContain('Worked out at settlement');
    }
  });

  it('says a failed payment has no fee', () => {
    expect(text('failed')).toContain('No fee: payment failed');
  });
});
