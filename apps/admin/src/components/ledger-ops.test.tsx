import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FREEZE_CONFIRM_PHRASE, LedgerOpsView, UNFREEZE_CONFIRM_PHRASE, type LedgerOpsViewProps } from './ledger-ops';

const treasury = {
  authority: 'treasury',
  tokenVar: 'ADMIN_TREASURY_TOKEN',
  configured: true,
  missing: [],
} as const;

function base(overrides: Partial<LedgerOpsViewProps> = {}): LedgerOpsViewProps {
  return {
    treasury,
    freeze: {
      ok: true,
      status: 200,
      state: {
        frozen: true,
        reason: 'reconciliation mismatch',
        actor: 'ops@example.test',
        changedAt: '2026-08-26T10:00:00.000Z',
      },
      detail: null,
    },
    pending: false,
    actionError: null,
    receipt: null,
    reconcile: null,
    reason: '',
    confirmation: '',
    resumeConfirmation: '',
    acknowledged: false,
    resumeAcknowledged: true,
    onReason: () => undefined,
    onConfirmation: () => undefined,
    onResumeConfirmation: () => undefined,
    onAcknowledge: () => undefined,
    onResumeAcknowledge: () => undefined,
    onFreeze: () => undefined,
    onUnfreeze: () => undefined,
    onReconcile: () => undefined,
    ...overrides,
  };
}

describe('LedgerOpsView confirmations and receipts', () => {
  it('requires the exact UNFREEZE LEDGER phrase before enabling resume', () => {
    const wrong = renderToStaticMarkup(<LedgerOpsView {...base({ resumeConfirmation: 'unfreeze ledger' })} />);
    const exact = renderToStaticMarkup(<LedgerOpsView {...base({ resumeConfirmation: UNFREEZE_CONFIRM_PHRASE })} />);

    expect(wrong).toContain(`Type <code>${UNFREEZE_CONFIRM_PHRASE}</code> to confirm`);
    expect(wrong).toContain('data-tone="primary" disabled="">Unfreeze ledger</button>');
    expect(exact).toContain('data-tone="primary">Unfreeze ledger</button>');
  });

  it('keeps the freeze confirmation exact and independent from unfreeze', () => {
    const html = renderToStaticMarkup(
      <LedgerOpsView
        {...base({
          freeze: {
            ok: true,
            status: 200,
            state: { frozen: false, reason: null, actor: null, changedAt: null },
            detail: null,
          },
          reason: 'reconciliation mismatch',
          confirmation: FREEZE_CONFIRM_PHRASE,
          resumeConfirmation: UNFREEZE_CONFIRM_PHRASE,
          acknowledged: true,
        })}
      />,
    );

    expect(html).toContain(`Type <code>${FREEZE_CONFIRM_PHRASE}</code> to confirm`);
    expect(html).toContain('data-tone="danger">Freeze ledger</button>');
  });

  it('renders an explicit receipt only from the returned money-plane state', () => {
    const html = renderToStaticMarkup(
      <LedgerOpsView
        {...base({
          receipt: {
            action: 'unfreeze',
            status: 200,
            state: {
              frozen: false,
              reason: null,
              actor: 'treasury-operator',
              changedAt: '2026-08-26T10:01:00.000Z',
            },
          },
        })}
      />,
    );

    expect(html).toContain('Service command receipt');
    expect(html).toContain('ledger-command-receipt');
    expect(html).toContain('svc-ledger answered');
    expect(html).toContain('treasury-operator');
    expect(html).toContain('2026-08-26T10:01:00.000Z');
  });
});

it('credential presence is transport configuration with unresolved action prerequisites', () => {
  const html = renderToStaticMarkup(<LedgerOpsView {...base()} />);
  expect(html).toContain('Credential transport');
  expect(html).toContain('transport only; approval required');
  expect(html).toContain('identity-issued approval and original operation guards');
  expect(html).not.toContain('this console can freeze');
});
