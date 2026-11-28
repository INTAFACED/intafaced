import { useState, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { uiCopy } from '../../../shared/ui-copy';
import { displayAmount, parseAmount } from '../../../shared/money';
import { draftId, keys, type AsOf, type OrderIntent, type VenuePreview, type VenueUp } from '../venue-api';
import { AsOfLine, Known, OutcomeLine, TestMark, word, type ActionResult, type RunAction, type VenueAccount } from './VenueKit';
import { venueCopy } from './venue-copy';

/** A discount in basis points of the fee as a percent of it, without trailing zeros: 5000 is "50", 25 is "0.25". */
export const bpsPercent = (bps: number): string => String(bps / 100);

/** The builder fee rate in bps this order requires approved: the preview's versioned rate, else the door's status rate. */
export function requiredBuilderFeeBps(
  status: Pick<VenueUp, 'builder'>,
  preview?: Pick<VenuePreview, 'builderFeeBps'> | null,
): string | null {
  if (preview && preview.builderFeeBps !== undefined) return preview.builderFeeBps;
  return status.builder?.feeBps ?? null;
}

/** Whether the account's approval covers our builder fee, from the venue's own record. */
export function builderApproved(
  account: VenueAccount,
  status: VenueUp,
  requiredBps: string | null = status.builder?.feeBps ?? null,
): boolean | null {
  if (!status.builder || requiredBps === null) return null;
  const approved = account.approval.data?.value;
  if (approved === undefined) return null;
  return parseAmount(approved) >= parseAmount(requiredBps);
}

/**
 * The words of the builder-fee approval line: a blank owner value is named as that, never only "not known"; an approval
 * the venue has not reported yet is not known.
 */
export function builderApprovalLine(
  published: boolean,
  approved: boolean | null,
  carriesBuilderFee = true,
): 'Builder approval not needed' | 'Builder fee owner blank' | 'Not known' | 'Builder approved' | 'Builder not approved' {
  if (!carriesBuilderFee) return 'Builder approval not needed';
  if (!published) return 'Builder fee owner blank';
  if (approved === null) return 'Not known';
  return approved ? 'Builder approved' : 'Builder not approved';
}

/**
 * Whether an order carries our builder fee, read from the venue's own preview: a known zero means it carries none (a
 * spot buy, which the venue charges no builder fee on; project-state PR 1888) and so needs no approval. Anything else,
 * including a fee the venue doesn't report, is treated as carrying one.
 */
export function carriesBuilderFee(builderFee: VenuePreview['builderFee']): boolean {
  return !(builderFee.known && /^0(\.0+)?$/.test(builderFee.value.amount));
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
  confirmDisabled = false,
  beforeConfirm,
  extra,
  after,
  result,
  onConfirm,
  onClose,
}: {
  title: string;
  preview: AsOf<VenuePreview>;
  intent: OrderIntent;
  status: VenueUp;
  account: VenueAccount;
  owner: string;
  run: RunAction;
  confirmLabel: string;
  /** Extra gate before Confirm can be pressed (e.g. accepting a higher margin tier, J-derivatives-02 #6). */
  confirmDisabled?: boolean;
  /** Content shown directly above the Confirm button (e.g. the new margin tier acceptance block). */
  beforeConfirm?: ReactNode;
  extra?: ReactNode;
  /** What follows the order's outcome on the sheet (the protections attached to an entry, J-derivatives-03 #4). */
  after?: ReactNode;
  result: ActionResult | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = venueCopy.useCopy();
  const { t: ui, languageFor: uiLanguage } = uiCopy.useCopy();
  const p = preview.value;
  const carries = carriesBuilderFee(p.builderFee);
  const requiredBps = requiredBuilderFeeBps(status, p);
  const approved = carries ? builderApproved(account, status, requiredBps) : true;
  const [approving, setApproving] = useState<ActionResult | null>(null);
  // The draft this review's builder approval is asked under (keys.builderApproval).
  const [approvalDraft] = useState(() => draftId());
  const [busy, setBusy] = useState(false);
  const feeBps = requiredBps ?? '';

  async function approve() {
    if (!status.builder || !requiredBps || busy) return;
    setBusy(true);
    const answer = await run(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: requiredBps },
      { actionKey: keys.builderApproval(owner, status.builder.address, requiredBps, undefined, approvalDraft) },
    );
    setBusy(false);
    setApproving(answer);
    account.reload();
  }

  const actions = (
    <>
      {approved === false ? (
        <Button tone="primary" disabled={busy} onClick={() => void approve()}>
          {t('Approve in wallet')}
        </Button>
      ) : null}
      <OutcomeLine result={approving} owner={owner} />
      {beforeConfirm}
      <div className="lt-row">
        <Button
          tone="primary"
          disabled={
            approved !== true || confirmDisabled || (result !== null && result.kind !== 'rejected' && result.kind !== 'wallet_failed')
          }
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button tone="secondary" onClick={onClose}>
          {t('Close review')}
        </Button>
      </div>
      <OutcomeLine result={result} owner={owner} />
    </>
  );

  return (
    <Sheet open title={title} onClose={onClose} closeLabel={ui('closeDialog')} closeLang={uiLanguage('closeDialog')}>
      <div data-testid="venue-review" className="lt-stack">
        <TestMark test={status.test} />
        {beforeConfirm ? actions : null}
        <dl className="lt-kv">
          <div>
            <dt>{t('Venue locks')}</dt>
            <dd className="lt-num lt-end" data-line="lock">
              {displayAmount(p.lock.amount)} {p.lock.asset}
            </dd>
          </div>
          <div>
            <dt>{t('Venue fee')}</dt>
            <dd className="lt-num lt-end" data-line="venue-fee">
              <Known value={p.venueFee.known ? { known: true, value: p.venueFee.value.amount } : { known: false }} />{' '}
              {p.venueFee.known ? p.venueFee.value.asset : ''}
            </dd>
          </div>
          <div>
            <dt>{t('Our builder fee')}</dt>
            <dd className="lt-num lt-end" data-line="builder-fee">
              {!carries ? (
                t('Builder none spot buy')
              ) : status.builder ? (
                <>
                  <Known value={p.builderFee.known ? { known: true, value: p.builderFee.value.amount } : { known: false }} />{' '}
                  {p.builderFee.known ? p.builderFee.value.asset : ''}
                </>
              ) : (
                <span role="alert">{t('Builder fee owner blank')}</span>
              )}
            </dd>
          </div>
          {carries && p.feeDiscount ? (
            <div>
              <dt>{t('Builder fee discount')}</dt>
              <dd className="lt-num lt-end" data-line="builder-fee-discount" data-source={p.feeDiscount.source}>
                {p.feeDiscount.source === 'coupon'
                  ? t('Builder discount coupon', { code: p.feeDiscount.code, pct: bpsPercent(p.feeDiscount.bps) })
                  : t('Builder discount rank', { pct: bpsPercent(p.feeDiscount.bps) })}
              </dd>
            </div>
          ) : null}
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
            <dd className="lt-num lt-end" data-line="client-id">
              {intent.clientOrderKey}
            </dd>
          </div>
          {extra}
          <div>
            <dt>{t('Builder approval')}</dt>
            <dd data-line="builder-approval">{t(builderApprovalLine(status.builder !== null, approved, carries), { bps: feeBps })}</dd>
          </div>
        </dl>
        <AsOfLine asOf={preview.asOf} />
        {beforeConfirm ? null : actions}
        {after}
      </div>
    </Sheet>
  );
}
