import { useState, type ReactNode } from 'react';
import { Button, Dialog } from '../../../shared/ui';
import { displayAmount, parseAmount } from '../../../shared/money';
import { keys, type AsOf, type OrderIntent, type VenuePreview, type VenueUp } from '../venue-api';
import { AsOfLine, Known, OutcomeLine, TestMark, word, type ActionResult, type RunAction, type VenueAccount } from './VenueKit';
import { venueCopy } from './venue-copy';

/** Whether the account's approval covers our builder fee, from the venue's own record. */
export function builderApproved(account: VenueAccount, status: VenueUp): boolean | null {
  if (!status.builder) return null;
  const approved = account.approval.data?.value;
  if (approved === undefined) return null;
  return parseAmount(approved) >= parseAmount(status.builder.feeBps);
}

/**
 * The Review sheet of one order, every line the venue's: what it locks, its fee and our builder fee as separate lines,
 * the fee role, the time in force and the client id held for retry, the builder-fee approval when the wallet has not
 * signed one (signed here, before the order), and, on a perpetual, `extra` (margin, liquidation, total). Confirm signs
 * and sends; a second press while it runs is the same action.
 */
export function ReviewDialog({
  title,
  preview,
  intent,
  status,
  account,
  owner,
  run,
  confirmLabel,
  extra,
  result,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  preview: AsOf<VenuePreview>;
  intent: OrderIntent;
  status: VenueUp;
  account: VenueAccount;
  owner: string;
  run: RunAction;
  confirmLabel: string;
  extra?: ReactNode;
  result: ActionResult | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = venueCopy.useCopy();
  const p = preview.value;
  const approved = builderApproved(account, status);
  const [approving, setApproving] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const feeBps = status.builder?.feeBps ?? '';

  async function approve() {
    if (!status.builder || busy) return;
    setBusy(true);
    const answer = await run(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      { actionKey: keys.builderApproval(owner, status.builder.address, status.builder.feeBps) },
    );
    setBusy(false);
    setApproving(answer);
    account.reload();
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <div data-testid="venue-review" className="form-stack">
        <TestMark test={status.test} />
        <dl className="protocol-facts">
          <div>
            <dt>{t('Venue locks')}</dt>
            <dd className="numeric" data-line="lock">
              {displayAmount(p.lock.amount)} {p.lock.asset}
            </dd>
          </div>
          <div>
            <dt>{t('Venue fee')}</dt>
            <dd className="numeric" data-line="venue-fee">
              <Known value={p.venueFee.known ? { known: true, value: p.venueFee.value.amount } : { known: false }} />{' '}
              {p.venueFee.known ? p.venueFee.value.asset : ''}
            </dd>
          </div>
          <div>
            <dt>{t('Our builder fee')}</dt>
            <dd className="numeric" data-line="builder-fee">
              <Known value={p.builderFee.known ? { known: true, value: p.builderFee.value.amount } : { known: false }} />{' '}
              {p.builderFee.known ? p.builderFee.value.asset : ''}
            </dd>
          </div>
          <div>
            <dt>{t('Fee role')}</dt>
            <dd data-line="role">{word(t, 'role', p.role)}</dd>
          </div>
          <div>
            <dt>{t('Time in force')}</dt>
            <dd data-line="tif">{word(t, 'tif', intent.timeInForce)}</dd>
          </div>
          <div>
            <dt>{t('Client id held')}</dt>
            <dd className="numeric" data-line="client-id">
              {intent.clientOrderKey}
            </dd>
          </div>
          {extra}
          <div>
            <dt>{t('Builder approval')}</dt>
            <dd data-line="builder-approval">
              {approved === null
                ? t('Not known')
                : approved
                  ? t('Builder approved', { bps: feeBps })
                  : t('Builder not approved', { bps: feeBps })}
            </dd>
          </div>
        </dl>
        <AsOfLine asOf={preview.asOf} />
        {approved === false ? (
          <Button disabled={busy} onClick={() => void approve()}>
            {t('Approve in wallet')}
          </Button>
        ) : null}
        <OutcomeLine result={approving} owner={owner} />
        <Button
          disabled={approved !== true || (result !== null && result.kind !== 'rejected' && result.kind !== 'wallet_failed')}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>{' '}
        <Button variant="secondary" onClick={onClose}>
          {t('Close review')}
        </Button>
        <OutcomeLine result={result} owner={owner} />
      </div>
    </Dialog>
  );
}
