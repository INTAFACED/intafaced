import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { PayFailure } from './components';
import { Button } from '@intafaced/ui';
import type { PersonalPayApi } from './pay-api';
import { validateCopy } from './p2p-validate-copy';
import type { Trade } from './schemas';

/**
 * P-trade-orders-11 / J-p2p-02 #4: on a paid order the seller may have the bank rail check the payment. The control is
 * always shown; while no rail is wired, or the rail does not cover the method, it stays off and names that blocker.
 */
export function ValidatePayment({ trade, pay, onChecked }: { trade: Trade; pay: PersonalPayApi; onChecked: () => void }) {
  const { t } = validateCopy.useCopy();
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<'pending' | 'released' | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  useEffect(() => {
    setAnswer(null);
    setFailure(null);
  }, [trade.id, trade.status]);
  const validation = trade.paymentValidation;
  const blocker = validation === undefined ? 'unread' : validation.blocker;
  const note =
    blocker === 'unread'
      ? t('unread')
      : blocker === 'rail.bank'
        ? t('railOff')
        : blocker === 'p2p.method_not_rail_validated'
          ? t('methodOff', { method: trade.method })
          : t('why');
  // svc-p2p's refusals in this room's words; anything else as the service said it.
  const refusal =
    failure?.code === 'rail.bank'
      ? t('railOff')
      : failure?.code === 'p2p.method_not_rail_validated'
        ? t('methodOff', { method: trade.method })
        : failure?.code === 'p2p.rail_mismatch'
          ? t('mismatch')
          : null;
  return (
    <div className="stack" data-testid="order-validate">
      <Button
        variant="secondary"
        disabled={blocker !== null || checking}
        onClick={async () => {
          setChecking(true);
          setFailure(null);
          const result = await pay.validatePayment(trade.id);
          setChecking(false);
          if (!result.ok) {
            setFailure(result);
            return;
          }
          setAnswer(result.data.outcome);
          if (result.data.outcome === 'released') onChecked();
        }}
      >
        {t('check')}
      </Button>
      <p className="muted" role="status">
        {answer ? t(answer) : note}
      </p>
      {refusal ? (
        <p className="failure" role="status">
          {refusal}
        </p>
      ) : failure ? (
        <PayFailure result={failure} />
      ) : null}
    </div>
  );
}
