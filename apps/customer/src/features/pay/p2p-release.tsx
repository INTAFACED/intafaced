import { useEffect, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { formatDateTime } from './portal/ui/format';
import { StepUpConfirm } from '../money/StepUpConfirm';
import { payCopy } from './copy';
import { PayAmount, PayDetails, ReviewedAction } from './components';
import { CounterpartyName } from './P2PCounterparty';
import type { PersonalPayApi } from './pay-api';
import { releaseCopy } from './p2p-release-copy';
import type { Trade } from './schemas';

const CHECKS = ['inMyBank', 'amountMatches', 'senderTerms', 'noReversal', 'stillProtected'] as const;
type Check = (typeof CHECKS)[number];

/**
 * J-p2p-02 #5 (P-trade-orders-16, -07): the seller releases the escrow once they have seen the money in their own bank.
 * The review names the buyer by handle (never the account id), shows what the buyer gets and the fee the release takes,
 * and asks the seller to tick five facts about the payment and to confirm it's them with a passkey or authenticator
 * code. Release stays off until both are done; the confirmation covers this one release only.
 */
export function ReleaseAction({
  trade,
  pay,
  release,
  onConfirmed,
  disabled,
}: {
  trade: Trade;
  pay: PersonalPayApi;
  release: (current: () => boolean, stepUpApprovalId: string | undefined) => Promise<ApiResult<Trade>>;
  onConfirmed: () => void;
  disabled: boolean;
}) {
  const { t, requestedLocale } = releaseCopy.useCopy();
  const [checks, setChecks] = useState<Record<Check, boolean>>({
    inMyBank: false,
    amountMatches: false,
    senderTerms: false,
    noReversal: false,
    stillProtected: false,
  });
  // undefined: not confirmed yet; null: no factor on the account, so the release goes without one and svc-p2p decides.
  const [approval, setApproval] = useState<string | null | undefined>(undefined);
  const buyer = useResource((signal) => pay.reputation(trade.buyerId, signal), `pay:reputation:${trade.buyerId}`);
  // A release confirmed in this session in the last ten minutes covers this one too; an unread window asks for a check.
  const covered = useResource((signal) => pay.releaseStepUpWindow(signal), `pay:release-step-up:${trade.id}`);
  const coveredUntil =
    covered.resource.status === 'ready' &&
    covered.resource.data.confirmedUntil &&
    Date.parse(covered.resource.data.confirmedUntil) > Date.now() + 30_000
      ? covered.resource.data.confirmedUntil
      : null;
  const confirmed = approval !== undefined || coveredUntil !== null;
  const ticked = CHECKS.every((key) => checks[key]);
  const preview = trade.releasePreview ?? null;
  return (
    <ReviewedAction
      title={t('release')}
      variant="primary"
      description={t('releaseWhy')}
      review={
        <div className="p2p-order-review" data-testid="order-release-review">
          <PayDetails
            values={[
              [payCopy.t('order'), <span lang="zxx">{trade.id}</span>],
              [t('releaseTo'), <CounterpartyName resource={buyer.resource} />],
              [t('gross'), <PayAmount value={trade.amount} unit={trade.asset} label={t('gross')} />],
              ...(preview
                ? ([
                    [t('buyerGets'), <PayAmount value={preview.netAmount} unit={trade.asset} label={t('buyerGets')} />],
                    [t('fee'), <PayAmount value={preview.fee} unit={trade.asset} label={t('fee')} />],
                  ] satisfies [string, ReactNode][])
                : ([[t('fee'), t('feeUnread')]] satisfies [string, ReactNode][])),
              [
                payCopy.t('paymentToVerify'),
                <PayAmount value={trade.fiatAmount} unit={trade.fiatCurrency} label={payCopy.t('paymentToVerify')} />,
              ],
              [payCopy.t('paymentMethod'), <span lang="zxx">{trade.method}</span>],
            ]}
          />
          <ReleaseChecklist trade={trade} checks={checks} onChange={setChecks} />
          {approval === undefined && coveredUntil ? (
            <p className="muted" role="status" data-testid="order-release-covered">
              {t('stepUpCovered', { time: formatDateTime(coveredUntil, requestedLocale)?.short ?? coveredUntil })}
            </p>
          ) : approval === undefined ? (
            <StepUpConfirm
              request={() => ({
                scope: 'p2p.step_up.trades.confirmReceived',
                purpose: 'trades.confirmReceived',
                target: trade.id,
                fields: { tradeId: trade.id },
              })}
              words={{
                why: t('stepUpWhy'),
                code: t('stepUpCode'),
                codeHint: t('stepUpCodeHint'),
                codeShort: t('stepUpCodeShort'),
                noFactor: t('stepUpNoFactor'),
                sendWithout: t('stepUpSendWithout'),
              }}
              disabled={disabled}
              onApproved={(id) => setApproval(id)}
            />
          ) : (
            <p className="muted" role="status" data-testid="order-release-confirmed">
              {approval ? t('stepUpDone') : t('stepUpNone')}
            </p>
          )}
        </div>
      }
      ready={ticked && confirmed}
      notReadyReason={t(ticked ? 'notConfirmed' : 'notTicked')}
      perform={async (current) => {
        const result = await release(current, approval ?? undefined);
        // A confirmation is spent once, kept or refused: the next try asks for a new one, and reads the window again.
        if (!result.ok) {
          setApproval(undefined);
          covered.reload();
        }
        return result;
      }}
      onConfirmed={onConfirmed}
      disabled={disabled}
    />
  );
}

function ReleaseChecklist({
  trade,
  checks,
  onChange,
}: {
  trade: Trade;
  checks: Record<Check, boolean>;
  onChange: (update: (current: Record<Check, boolean>) => Record<Check, boolean>) => void;
}) {
  const { t } = releaseCopy.useCopy();
  // A new order on the same page starts unticked.
  useEffect(() => onChange(() => Object.fromEntries(CHECKS.map((key) => [key, false])) as Record<Check, boolean>), [trade.id]);
  return (
    <fieldset className="p2p-paid-checklist" data-testid="order-release-checklist">
      <legend>{t('checklist')}</legend>
      {CHECKS.map((key) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={checks[key]}
            onChange={(event) => {
              // Read it now: React puts a controlled box back before a functional update runs.
              const checked = event.target.checked;
              onChange((current) => ({ ...current, [key]: checked }));
            }}
          />
          <span>
            {key === 'amountMatches'
              ? t('amountMatches', { amount: displayAmount(trade.fiatAmount), currency: trade.fiatCurrency })
              : t(key)}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
