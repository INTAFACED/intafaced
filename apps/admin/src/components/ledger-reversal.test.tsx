import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpsLedgerReversal } from '@intafaced/contracts/ops-ledger-reversals';
import type { LedgerTransaction } from '@/lib/ledger-lookup';
import { explainRefusal, type RefusalView } from '@/lib/refusal-copy';
import { LedgerReversalView, type AskView, type ListView } from './ledger-reversal';
import { TransactionView } from './ledger-lookup';

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVERSING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T = '2026-11-24T08:00:00.000Z';
const row = (over: Partial<OpsLedgerReversal> = {}): OpsLedgerReversal => ({
  requestNo: '1',
  originalTxId: ORIGINAL,
  ordinal: '1',
  reason: 'LOCAL TEST posted to the wrong account',
  caseRef: 'CASE-7',
  state: 'intent',
  requestedBy: FOUNDER,
  requestedAt: T,
  approverId: null,
  approvedAt: null,
  ledgerKey: `ops:reversal:${ORIGINAL}:1`,
  reversingTxId: null,
  code: null,
  reversedBy: null,
  attempts: 0,
  lastAttemptAt: null,
  settledAt: null,
  ...over,
});
const render = (list: ListView, ask: AskView = { kind: 'idle' }, form = { reason: '', caseRef: '' }) =>
  renderToStaticMarkup(
    <LedgerReversalView
      txId={ORIGINAL}
      userId={FOUNDER}
      list={list}
      ask={ask}
      reason={form.reason}
      caseRef={form.caseRef}
      onReason={() => undefined}
      onCaseRef={() => undefined}
      onSubmit={() => undefined}
      onRequestChanged={() => undefined}
      onFollow={() => undefined}
    />,
  );
const ok = (reversals: OpsLedgerReversal[], writes: RefusalView | null = null): ListView => ({
  kind: 'ok',
  reversals,
  writes,
  asOf: T,
});

describe('the reversal control (J-ops-console-05 #1-#3)', () => {
  it('an asked reversal waits at intent with the packet desk to ask a different founder; nothing has posted', () => {
    const html = render(ok([row()]), { kind: 'asked', reversal: row() });
    expect(html).toContain('data-testid="reversal-state">intent<');
    expect(html).toContain('nothing has posted');
    expect(html).toContain('data-testid="control-desk"');
    expect(html).toContain('REVERSE REQUEST 1');
    expect(html).toContain('data-testid="reversal-asked" data-request-no="1"');
    expect(html).not.toContain('reversal-reversing-tx');
  });

  it('a posted reversal names the reversing transaction and offers no second approval', () => {
    const html = render(
      ok([row({ state: 'posted', approverId: '88888888-8888-4888-8888-888888888888', reversingTxId: REVERSING, settledAt: T })]),
    );
    expect(html).toContain('data-testid="reversal-state">posted<');
    expect(html).toContain(`data-testid="reversal-reversing-tx" data-tx-id="${REVERSING}"`);
    expect(html).not.toContain('data-testid="control-desk"');
  });

  it('reversing again shows ops.reversal_already_reversed and the first reversal', () => {
    const html = render(ok([row({ state: 'posted', reversingTxId: REVERSING, approverId: 'x', settledAt: T })]), {
      kind: 'refused',
      refusal: explainRefusal('ops.reversal_already_reversed', 409, false),
      firstReversal: { requestNo: '1', reversingTxId: REVERSING },
    });
    expect(html).toContain('data-testid="reversal-refused-code">ops.reversal_already_reversed<');
    expect(html).toContain(`data-testid="reversal-first" data-tx-id="${REVERSING}"`);
    expect(html).toContain('This transaction is already reversed');
  });

  it('a lost reply shows pending retry with the ledger’s code, and a refusal its code', () => {
    expect(render(ok([row({ state: 'pending_retry', approverId: 'x', code: 'ledger.reply_lost', attempts: 1 })]))).toContain(
      'data-testid="reversal-code">ledger.reply_lost<',
    );
    expect(render(ok([row({ state: 'refused', approverId: 'x', code: 'ledger.insufficient_funds', settledAt: T })]))).toContain(
      'data-testid="reversal-state">refused<',
    );
  });

  it('the Reverse button waits for a reason and a case reference, and a founder without the treasury credential is told why', () => {
    expect(render(ok([]))).toMatch(/data-testid="tx-reverse-submit" disabled=""/);
    expect(render(ok([]))).toContain('data-testid="reversal-none"');
    expect(render(ok([]), { kind: 'idle' }, { reason: 'LOCAL TEST wrong account', caseRef: 'CASE-7' })).not.toMatch(
      /data-testid="tx-reverse-submit" disabled=""/,
    );
    const parked = render(
      ok([], explainRefusal('admin.ledger_unconfigured', 503, false)),
      { kind: 'idle' },
      {
        reason: 'LOCAL TEST wrong account',
        caseRef: 'CASE-7',
      },
    );
    expect(parked).toContain('data-testid="reversal-writes-parked"');
    expect(parked).toMatch(/data-testid="tx-reverse-submit" disabled=""/);
  });

  it('svc-ops not answering is said, never shown as no reversals', () => {
    const html = render({ kind: 'refused', refusal: explainRefusal('ops.reversal_storage_unconfigured', 412, false) });
    expect(html).toContain('data-testid="reversal-list-refused"');
    expect(html).toContain('ops.reversal_storage_unconfigured');
    expect(html).not.toContain('reversal-none');
  });
});

describe('a transaction’s reversal links', () => {
  const tx: LedgerTransaction = {
    txId: ORIGINAL,
    businessKey: 'deposit:local-test:TEST-1',
    module: 'ledger',
    reason: 'deposit.credited',
    postedAt: T,
    hash: 'h1',
    previousHash: 'h0',
    booking: { seq: '51', bookedAt: T, reference: null, event: null },
    postings: [
      {
        entryId: 'e1',
        accountId: 'a1',
        assetId: 'USDT',
        direction: 'credit',
        side: 'source',
        amount: '25',
        balanceBefore: '0',
        balanceAfter: '-25',
      },
    ],
    reversedBy: null,
    reverses: null,
  };

  it('the original shows "Reverted by" the reversing id, the reversal "Reverses" the original', () => {
    expect(renderToStaticMarkup(<TransactionView transaction={tx} readAt={T} />)).toContain('Not reversed');
    const original = renderToStaticMarkup(<TransactionView transaction={{ ...tx, reversedBy: REVERSING }} readAt={T} />);
    expect(original).toContain(`data-testid="tx-reversed-by" data-tx-id="${REVERSING}"`);
    expect(original).toContain('Reverted by');
    const reversal = renderToStaticMarkup(<TransactionView transaction={{ ...tx, txId: REVERSING, reverses: ORIGINAL }} readAt={T} />);
    expect(reversal).toContain(`data-testid="tx-reverses" data-tx-id="${ORIGINAL}"`);
    expect(reversal).toContain('Reverses');
  });

  it('the reverse control shows only where the lookup passes the founder', () => {
    expect(renderToStaticMarkup(<TransactionView transaction={tx} readAt={T} />)).not.toContain('tx-reversal"');
    expect(
      renderToStaticMarkup(<TransactionView transaction={tx} readAt={T} reversal={{ userId: FOUNDER, onChanged: () => undefined }} />),
    ).toContain('data-testid="tx-reverse"');
  });
});
