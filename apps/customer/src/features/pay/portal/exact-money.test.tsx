import type { ReactNode } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// A review dialog is closed until it is clicked, and there is no browser here. Draw the review body in place so the
// test sees what the merchant would see inside the dialog. `PortalReview` is the real one: it supplies the exact scope.
vi.mock('../components', async (original) => {
  const real = await original<typeof import('../components')>();
  return { ...real, ReviewedAction: ({ review }: { review?: ReactNode }) => <div data-review>{review}</div> };
});

import { ApprovalDecision, CancelRequest } from './money/Approvals';
import { DisputeDetailView } from './payments/Disputes';
import { Money } from './components';
import { ExactMoneyContext } from './presentation';
import { ExactMoneyScope } from './ui/ExactMoneyScope';
import { PortalReview } from './ui/PortalReview';
import type { PortalApi } from './api';
import type { Approval, DisputeDetail } from './schemas';

// TEST DATA: the amount has six decimals so a compact "12.35" can be told from the exact "12.345678".
const AMOUNT = '12.345678';
const approval: Approval = {
  approvalId: 'cc000001-0000-4000-8000-000000000001',
  merchantId: '11111111-1111-4111-8111-111111111111',
  settlementId: 'bb000003-0000-4000-8000-000000000003',
  amount: AMOUNT,
  assetCode: 'USDT',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  status: 'pending',
  makerUserId: 'TEST-maker',
  checkerUserId: null,
  createdAt: '2026-10-15T09:00:00.000Z',
  decidedAt: null,
  expiresAt: '2099-10-16T09:00:00.000Z',
};
const portal = {} as PortalApi;
const noop = () => undefined;

describe('money in a review is exact, wherever it was opened from', () => {
  it('shows the exact amount in the approval decision dialog, on a list page', () => {
    const out = renderToString(
      <ApprovalDecision portal={portal} approval={approval} me="TEST-checker" role="finance" now={Date.now()} onDone={noop} />,
    );
    expect(out).toContain(AMOUNT);
    expect(out).not.toContain('12.35<');
  });
  it('shows the exact amount in the cancel dialog', () => {
    const out = renderToString(
      <CancelRequest portal={portal} approval={{ ...approval, makerUserId: 'TEST-checker' }} me="TEST-checker" onDone={noop} />,
    );
    expect(out).toContain(AMOUNT);
  });
  it('shows the exact amount when a merchant accepts liability for a dispute', () => {
    const dispute = {
      disputeId: 'd0000001-0000-4000-8000-000000000001',
      paymentId: 'aa000001-0000-4000-8000-000000000001',
      amount: AMOUNT,
      assetId: 'USDT',
      reasonCode: 'fraudulent',
      status: 'open',
      openedAt: '2026-10-10T00:00:00.000Z',
      contestedAt: null,
      closedAt: null,
      responseDueAt: null,
      ledgerWire: 'refused',
      ledgerRefuseCode: 'pay.chargeback_wire_absent',
      canRespond: true,
      evidence: [],
      responses: [],
      payment: null,
    } as unknown as DisputeDetail;
    const out = renderToString(<DisputeDetailView portal={portal} dispute={{ status: 'ready', data: dispute }} reload={noop} />);
    expect(out).toContain(AMOUNT);
  });
  it('wraps any review body in the exact scope', () => {
    const out = renderToString(
      <PortalReview
        title="Go"
        description="d"
        review={<Money value={AMOUNT} asset="USDT" />}
        perform={async () => ({ ok: true, data: 1 })}
      />,
    );
    expect(out).toContain(AMOUNT);
  });
});

describe('money in a list stays compact', () => {
  it('shows 12.35 in a list row, with no way to expand it outside a detail page', () => {
    const out = renderToString(<Money value={AMOUNT} asset="USDT" />);
    expect(out).toContain('12.35');
    expect(out).not.toContain(AMOUNT);
    expect(out).not.toContain('Show exact');
  });
  it('keeps a "Show exact" control in a detail page, compact by default', () => {
    const out = renderToString(
      <ExactMoneyContext.Provider value>
        <Money value={AMOUNT} asset="USDT" />
      </ExactMoneyContext.Provider>,
    );
    expect(out).toContain('12.35');
    expect(out).toContain('Show exact');
  });
  it('shows exact inside a review even where the page is a list', () => {
    const out = renderToString(
      <ExactMoneyScope>
        <Money value={AMOUNT} asset="USDT" />
      </ExactMoneyScope>,
    );
    expect(out).toContain(AMOUNT);
    expect(out).not.toContain('Show exact');
  });
});

describe('one door for confirmations', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  it('lets only ui/PortalReview.tsx import ReviewedAction', () => {
    const offenders = files(root)
      .filter((file) => !file.endsWith('ui/PortalReview.tsx') && !file.endsWith('exact-money.test.tsx'))
      .filter((file) => /\bReviewedAction\b/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(root.length))).toEqual([]);
  });
});
