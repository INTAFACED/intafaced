import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { Resource } from '../../../../shared/resource';
import { DisputeFundsView } from './Disputes';
import { disputeFundsSchema, type DisputeFunds } from './dispute-funds-api';

// TEST DATA written for these tests: what the TEST acquirer reported for one dispute, no real partner or amount.
const funds = (patch: Partial<DisputeFunds> = {}): Resource<DisputeFunds> => ({
  status: 'ready',
  data: disputeFundsSchema.parse({
    disputeId: 'TEST-dp-1',
    assetId: 'USDT',
    status: 'lost',
    disputed: '60',
    takenAtOpening: '40',
    openingBooked: true,
    notYetTaken: '20',
    returned: '0',
    shortfall: '0',
    shortfallRecovered: '0',
    ...patch,
  }),
});
const text = (el: ReactElement) =>
  renderToString(el)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|’/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

describe("a dispute's money on its case page (M-disp-01; J-merchant-18 #5)", () => {
  it('a lost dispute on a short balance shows what was taken once and what was not taken', () => {
    const out = text(<DisputeFundsView funds={funds()} retry={() => {}} test={false} />);
    expect(out).toContain('Disputed 60.00 USDT');
    expect(out).toContain('Taken at opening 40.00 USDT');
    expect(out).toContain('Returned 0.00 USDT');
    expect(out).toContain('Not yet taken 20.00 USDT');
    expect(out).toContain('The rest of the disputed amount was not taken from your balance.');
    expect(out).toContain('the loss is not taken twice');
    expect(out).not.toContain('Covered by INTAFACED');
  });

  it('a won dispute returns what the opening took, and says nothing was left untaken', () => {
    const out = text(
      <DisputeFundsView
        funds={funds({ status: 'won', disputed: '25', takenAtOpening: '25', returned: '25', notYetTaken: '0' })}
        retry={() => {}}
        test={false}
      />,
    );
    expect(out).toContain('Taken at opening 25.00 USDT');
    expect(out).toContain('Returned 25.00 USDT');
    expect(out).not.toContain('was not taken from your balance');
    expect(out).toContain('You won: what was taken at opening came back.');
  });

  it("a part the house covered under the partner's terms, and its recovery, are shown so the figures add up", () => {
    const out = text(
      <DisputeFundsView funds={funds({ notYetTaken: '0', shortfall: '20', shortfallRecovered: '5' })} retry={() => {}} test={false} />,
    );
    expect(out).toContain("Covered by INTAFACED, under the partner's terms 20.00 USDT");
    expect(out).toContain('Covered part taken back after a win 5.00 USDT');
    expect(out).not.toContain('was not taken from your balance');
  });

  it('an opening not booked yet says so; a read that fails is a refusal in words with no figure', () => {
    const pending = text(
      <DisputeFundsView
        funds={funds({ status: 'open', openingBooked: false, takenAtOpening: '0', notYetTaken: '60', shortfall: null })}
        retry={() => {}}
        test
      />,
    );
    expect(pending).toContain("opening isn't booked yet, so nothing has been taken");
    expect(pending).toContain('TEST');
    const failed: Resource<DisputeFunds> = {
      status: 'failed',
      failure: { ok: false, status: 503, reason: 'error', code: 'pay.dispute_funds_unavailable', message: 'x' } as never,
    };
    const out = text(<DisputeFundsView funds={failed} retry={() => {}} test={false} />);
    expect(out).toContain("We can't show where this dispute's money is right now.");
    expect(out).not.toMatch(/\d+\.\d{2} USDT/);
  });
});
