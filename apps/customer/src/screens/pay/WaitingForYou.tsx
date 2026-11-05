import { useEffect, useId, useState } from 'react';
import {
  answerWaitingPayment,
  Button,
  fetchWaitingPayments,
  fmtAmount,
  HIDDEN_MASK,
  useHideBalances,
  useSession,
  type ReceivedHold,
} from './deps';
import { payCopy } from './copy';
import { PAY_SENT_EVENT } from './recent-model';

type Loaded = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; list: ReceivedHold[] };

/**
 * Pay's "Waiting for you" (PP-money-balance-05, J-pay-03 #5): payments from people not in the customer's contacts, held
 * because they chose to accept those first. Each names who sent it, the amount, why it waits and the date it goes back to
 * the sender if not answered. Accept puts it in the balance; Deny sends it back. Both are the bank's answer, read again
 * after; nothing here counts money itself. Shown only when something is waiting, or when the list could not be read.
 */
export function WaitingForYou() {
  const { api } = useSession();
  const hidden = useHideBalances();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ transferId: string; text: string } | null>(null);
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetchWaitingPayments(api, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setLoaded(outcome.kind === 'ok' ? { status: 'ready', list: outcome.data } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, revision]);

  useEffect(() => {
    const again = () => setRevision((n) => n + 1);
    window.addEventListener(PAY_SENT_EVENT, again);
    return () => window.removeEventListener(PAY_SENT_EVENT, again);
  }, []);

  async function answer(hold: ReceivedHold, choice: 'accept' | 'deny') {
    if (busy) return;
    setBusy(hold.transferId);
    setProblem(null);
    const outcome = await answerWaitingPayment(api, choice, hold.transferId);
    setBusy(null);
    if (outcome.kind !== 'ok') {
      const code = outcome.kind === 'refused' ? outcome.code : null;
      setProblem({
        transferId: hold.transferId,
        text:
          code === 'bank.received_hold_not_ready'
            ? payCopy.t('Waiting not ready')
            : code === 'bank.received_hold_decided'
              ? payCopy.t('Waiting already answered')
              : payCopy.t('Waiting answer failed'),
      });
    }
    setRevision((n) => n + 1);
  }

  if (loaded.status === 'loading' || (loaded.status === 'ready' && loaded.list.length === 0)) return null;
  return (
    <section className="pay-recent pay-waiting" aria-labelledby={titleId} data-testid="pay-waiting">
      <h2 id={titleId} className="pay-recent__title">
        {payCopy.t('Waiting for you')}
      </h2>
      {loaded.status === 'failed' ? (
        <p className="pay-problem" role="alert">
          {payCopy.t('Waiting load failed')}{' '}
          <button type="button" className="pay-recent__link" onClick={() => setRevision((n) => n + 1)}>
            {payCopy.t('Retry')}
          </button>
        </p>
      ) : (
        <ul className="pay-waiting__list">
          {loaded.list.map((hold) => {
            const who = hold.fromHandle ? `@${hold.fromHandle}` : payCopy.t('Someone not in your contacts');
            const amount = hidden ? HIDDEN_MASK : `${fmtAmount(hold.amount)} ${hold.assetId}`;
            const date = new Date(hold.releaseAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
            // Only a held payment before its date can be answered; every other state says where it stands.
            const expired = Date.parse(hold.releaseAt) <= Date.now();
            const open = hold.state === 'held' && !expired;
            const where =
              hold.state === 'placing'
                ? payCopy.t('Waiting not ready')
                : hold.state === 'releasing'
                  ? payCopy.t('Waiting accepted')
                  : hold.state === 'returning' || expired
                    ? payCopy.t('Waiting going back')
                    : null;
            return (
              <li key={hold.transferId} className="pay-waiting__item" data-testid="pay-waiting-item" data-state={hold.state}>
                <p className="pay-waiting__head">
                  <span>{payCopy.t('{who} sent you {amount}', { who, amount })}</span>
                </p>
                <p className="pay-hint">{payCopy.t('Waiting reason stranger')}</p>
                {hold.note ? <p className="pay-hint">{hold.note}</p> : null}
                <p className="pay-hint">{payCopy.t('Waiting goes back {date}', { date })}</p>
                <div className="pay-row-actions">
                  <Button
                    variant="primary"
                    size={40}
                    disabled={busy !== null || !open}
                    onClick={() => void answer(hold, 'accept')}
                    aria-label={payCopy.t('Accept {amount} from {who}', { amount, who })}
                  >
                    {payCopy.t('Accept')}
                  </Button>
                  <Button
                    variant="secondary"
                    size={40}
                    disabled={busy !== null || !open}
                    onClick={() => void answer(hold, 'deny')}
                    aria-label={payCopy.t('Deny {amount} from {who}', { amount, who })}
                  >
                    {payCopy.t('Deny')}
                  </Button>
                </div>
                {where ? <p className="pay-hint">{where}</p> : null}
                {problem?.transferId === hold.transferId ? (
                  <p className="pay-problem" role="alert">
                    {problem.text}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
