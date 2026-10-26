import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { PayFailure } from './components';
import { Button } from '@intafaced/ui';
import { formatDateTime } from './portal/ui/format';
import { StepUpConfirm } from '../money/StepUpConfirm';
import type { PersonalPayApi } from './pay-api';
import { releaseCopy } from './p2p-release-copy';
import { validateCopy } from './p2p-validate-copy';
import type { Trade } from './schemas';

/** Refusals said in this room's words: nothing was released, and what to do next. */
const REFUSALS = {
  'rail.bank': 'railOff',
  'p2p.method_not_rail_validated': 'methodOff',
  'p2p.rail_mismatch': 'mismatch',
  'auth.step_up_required': 'confirmAgain',
  'auth.step_up_expired': 'confirmAgain',
  'auth.step_up_failed': 'confirmAgain',
  'p2p.step_up_unverifiable': 'confirmUnchecked',
} as const;

/**
 * P-trade-orders-11 / J-p2p-02 #4: on a paid order the seller may have the bank rail check the payment. The control is
 * always shown; while no rail is wired, or the rail does not cover the method, it stays off and names that blocker. A
 * check that can release asks for the same confirmation as a release by hand, or rides the session's release window.
 */
export function ValidatePayment({ trade, pay, onChecked }: { trade: Trade; pay: PersonalPayApi; onChecked: () => void }) {
  const { t, requestedLocale } = validateCopy.useCopy();
  const release = releaseCopy.useCopy().t;
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  // undefined: not confirmed yet; null: no factor on the account, so the check goes without one and svc-p2p decides.
  const [approval, setApproval] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setPending(false);
    setFailure(null);
    setApproval(undefined);
  }, [trade.id, trade.status]);
  const validation = trade.paymentValidation;
  const blocker = validation === undefined ? 'unread' : validation.blocker;
  const covered = useResource((signal) => pay.releaseStepUpWindow(signal), `pay:release-step-up:${trade.sellerId}`);
  const coveredUntil =
    covered.resource.status === 'ready' &&
    covered.resource.data.confirmedUntil &&
    Date.parse(covered.resource.data.confirmedUntil) > Date.now() + 30_000
      ? covered.resource.data.confirmedUntil
      : null;
  const confirmed = approval !== undefined || coveredUntil !== null;
  const note =
    blocker === 'unread'
      ? t('unread')
      : blocker === 'rail.bank'
        ? t('railOff')
        : blocker === 'p2p.method_not_rail_validated'
          ? t('methodOff', { method: trade.method })
          : pending
            ? t('pending')
            : t('why');
  const words = failure?.code ? REFUSALS[failure.code as keyof typeof REFUSALS] : undefined;
  return (
    <div className="stack" data-testid="order-validate">
      {blocker === null && !confirmed ? (
        <StepUpConfirm
          request={() => ({
            scope: 'p2p.step_up.trades.confirmReceived',
            purpose: 'trades.confirmReceived',
            target: trade.id,
            fields: { tradeId: trade.id },
          })}
          words={{
            why: t('confirmWhy'),
            code: release('stepUpCode'),
            codeHint: release('stepUpCodeHint'),
            codeShort: release('stepUpCodeShort'),
            noFactor: release('stepUpNoFactor'),
            sendWithout: release('stepUpSendWithout'),
          }}
          disabled={checking}
          onApproved={(id) => setApproval(id)}
        />
      ) : blocker === null && approval === undefined && coveredUntil ? (
        <p className="muted">{release('stepUpCovered', { time: formatDateTime(coveredUntil, requestedLocale)?.short ?? coveredUntil })}</p>
      ) : null}
      <Button
        variant="secondary"
        disabled={blocker !== null || !confirmed || checking}
        onClick={async () => {
          setChecking(true);
          setFailure(null);
          setPending(false);
          const result = await pay.validatePayment(trade.id, approval ?? undefined);
          setChecking(false);
          // A confirmation is spent once: the next check asks again unless the window covers it.
          setApproval(undefined);
          covered.reload();
          if (!result.ok) {
            setFailure(result);
            return;
          }
          if (result.data.outcome === 'pending') setPending(true);
          // Released: the order reads again and shows Completed.
          else onChecked();
        }}
      >
        {t('check')}
      </Button>
      <p className="muted" role="status">
        {note}
      </p>
      {words ? (
        <p data-testid="failure" className="failure" role="status">
          {t(words, { method: trade.method })}
        </p>
      ) : failure ? (
        <PayFailure result={failure} />
      ) : null}
    </div>
  );
}
