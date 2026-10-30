import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Field, Input, KeyValue } from '@intafaced/ui';
import { StepUpConfirm } from '../../../features/money/StepUpConfirm';
import { displayAmount } from '../../../shared/money';
import type { createRoomApi, GridBot, GridWithdrawal } from './api';
import { roomCopy } from './copy';
import type { Failure } from './guard';
import { AccountBadge, RefusalNote } from './parts';

// One key per withdrawal intent: kept while a reply is lost, so a resend is the same withdrawal; renewed after any answer.
const newRequestKey = () => `withdraw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Withdraw grid profit (CB-bots-05; J-copy-bots-otc-14 #7). The person names an amount, confirms it with a passkey or
 * authenticator code for exactly that amount (identity's step-up), and the service checks the owner's daily cap and the
 * profit the bot holds. Every refusal is the service's own code in words; the receipt is the stored withdrawal row.
 */
export function GridWithdraw({ bot, api, onDone }: { bot: GridBot; api: ReturnType<typeof createRoomApi>; onDone: () => void }) {
  const { t } = roomCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [requestId, setRequestId] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [receipt, setReceipt] = useState<GridWithdrawal | null>(null);
  // The confirmation is for one amount: a changed amount needs a new one.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const asset = bot.quoteAsset;

  const reset = () => {
    setAmount('');
    setRequestId(newRequestKey());
    setFailure(null);
    setReceipt(null);
    setConfirmFor(null);
  };

  async function send(stepUpApprovalId: string | null) {
    if (busy || confirmFor === null) return;
    setBusy(true);
    setFailure(null);
    const result = await api.gridWithdraw({ botId: bot.botId, requestId, asset, amount: confirmFor, stepUpApprovalId });
    setBusy(false);
    if (result.ok) {
      setReceipt(result.data);
      onDone();
      return;
    }
    setFailure(result);
    setConfirmFor(null);
    // A lost reply keeps the key, so the resend reads the same withdrawal; any definite answer starts a new one.
    if (result.reason !== 'uncertain') setRequestId(newRequestKey());
  }

  return (
    <>
      <div className="cb-action-row">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t('Withdraw profit')}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="cb-dialog">
          <DialogHeader>
            <DialogTitle>{t('Withdraw profit')}</DialogTitle>
            <DialogDescription>
              {t('The profit goes back to your free {asset} balance. Your bot keeps its investment.', { asset })}
            </DialogDescription>
          </DialogHeader>
          {receipt ? (
            <section aria-label={t('Withdrawal receipt')} data-testid="grid-withdraw-receipt" className="cb-form">
              <AccountBadge paper={false} />
              <KeyValue
                items={[
                  { label: t('Withdrawal ID'), value: receipt.withdrawalId },
                  { label: t('Bot ID'), value: receipt.botId },
                  { label: t('Asset'), value: receipt.asset },
                  { label: t('Amount'), value: `${displayAmount(receipt.amount)} ${receipt.asset}` },
                  { label: t('Profit before'), value: `${displayAmount(receipt.profitBefore)} ${receipt.asset}` },
                  { label: t('Profit after'), value: `${displayAmount(receipt.profitAfter)} ${receipt.asset}` },
                  { label: t('Set aside before'), value: `${displayAmount(receipt.reserveBefore)} ${receipt.asset}` },
                  { label: t('Set aside after'), value: `${displayAmount(receipt.reserveAfter)} ${receipt.asset}` },
                  { label: t('Daily cap'), value: `${displayAmount(receipt.dailyCap)} ${receipt.asset}` },
                  { label: t('Used today'), value: `${displayAmount(receipt.capUsed)} ${receipt.asset}` },
                  { label: t('Left today'), value: `${displayAmount(receipt.capRemaining)} ${receipt.asset}` },
                  { label: t('Confirmation ID'), value: receipt.stepUpEventId },
                  { label: t('Time'), value: receipt.appliedAt },
                ]}
              />
            </section>
          ) : (
            <div className="cb-form">
              <Field label={t('Amount, {asset}', { asset })}>
                <Input
                  kind="decimal"
                  value={amount}
                  onValueChange={setAmount}
                  precision={8}
                  trailing={asset}
                  disabled={busy || confirmFor !== null}
                />
              </Field>
              <p className="cb-note-body">
                {t('Withdrawable now: {amount} {asset}', { amount: displayAmount(bot.withdrawableProfit), asset })}
              </p>
              {confirmFor === null ? (
                <Button disabled={busy} onClick={() => setConfirmFor(amount)}>
                  {t('Continue')}
                </Button>
              ) : (
                <StepUpConfirm
                  request={() => ({
                    scope: 'trade.step_up.bots.grid.withdrawProfit',
                    purpose: 'bots.grid.withdrawProfit',
                    target: bot.botId,
                    amount: confirmFor,
                    fields: { botId: bot.botId, requestId, asset, amount: confirmFor },
                  })}
                  words={{
                    why: t('Confirm it’s you to withdraw {amount} {asset}.', { amount: confirmFor, asset }),
                    code: t('Authenticator code'),
                    codeHint: t('The 6-digit code from your authenticator app'),
                    codeShort: t('Enter all 6 digits'),
                    noFactor: t('You have no passkey or authenticator app, so this withdrawal cannot be confirmed.'),
                    sendWithout: t('Send without confirming'),
                  }}
                  disabled={busy}
                  onApproved={(id) => void send(id)}
                />
              )}
              {failure ? <RefusalNote failure={failure} /> : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
