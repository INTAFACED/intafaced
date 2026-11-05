import { useEffect, useId, useState } from 'react';
import { fetchReceiveRule, setReceiveRule, useSession, type ReceiveRule, type StrangerRule as Rule } from './deps';
import { payCopy } from './copy';

type Loaded = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rule: ReceiveRule };

/**
 * Receive's rule for payments from people not in the customer's contacts (PP-money-balance-05, J-pay-03 #5): paid into
 * the balance, or held for them to accept or deny on Pay. "Not in your contacts" is someone you have never paid. The
 * choice is the bank's, read back from it; a release period the owner has not published refuses "hold" and says so.
 */
export function StrangerRule() {
  const { api } = useSession();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = useId();
  const titleId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetchReceiveRule(api, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setLoaded(outcome.kind === 'ok' ? { status: 'ready', rule: outcome.data } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, revision]);

  async function choose(next: Rule) {
    if (busy || loaded.status !== 'ready' || loaded.rule.strangers === next) return;
    const before = loaded.rule;
    // The choice shows at once while the bank stores it; a refusal puts the stored one back and says why.
    setLoaded({ status: 'ready', rule: { ...before, strangers: next } });
    setBusy(true);
    setProblem(null);
    const outcome = await setReceiveRule(api, next);
    setBusy(false);
    if (outcome.kind === 'ok') return setLoaded({ status: 'ready', rule: outcome.data });
    setLoaded({ status: 'ready', rule: before });
    setProblem(
      outcome.kind === 'refused' && outcome.code === 'bank.stranger_hold_period_unset'
        ? payCopy.t('Stranger hold unset')
        : payCopy.t('Stranger rule failed'),
    );
  }

  const rule = loaded.status === 'ready' ? loaded.rule : null;
  return (
    <fieldset className="pay-block pay-stranger" data-testid="stranger-rule" aria-labelledby={titleId} disabled={busy || !rule}>
      <legend id={titleId} className="pay-section-title">
        {payCopy.t('Payments from people not in your contacts')}
      </legend>
      <p className="pay-hint">{payCopy.t('Stranger rule hint')}</p>
      {loaded.status === 'failed' ? (
        <p className="pay-problem" role="alert">
          {payCopy.t('Stranger rule load failed')}{' '}
          <button type="button" className="pay-recent__link" onClick={() => setRevision((n) => n + 1)}>
            {payCopy.t('Retry')}
          </button>
        </p>
      ) : null}
      <label className="pay-stranger__option">
        <input type="radio" name={name} checked={rule?.strangers === 'pay_in'} onChange={() => void choose('pay_in')} />
        {payCopy.t('Pay them into my balance')}
      </label>
      <label className="pay-stranger__option">
        <input type="radio" name={name} checked={rule?.strangers === 'hold'} onChange={() => void choose('hold')} />
        {payCopy.t('Hold for me to accept')}
      </label>
      {rule?.strangers === 'hold' && rule.holdDays !== null ? (
        <p className="pay-hint" data-testid="stranger-hold-days">
          {payCopy.t('Stranger hold days {n}', { n: String(rule.holdDays) })}
        </p>
      ) : null}
      {rule && rule.holdDays === null ? <p className="pay-hint">{payCopy.t('Stranger hold unset')}</p> : null}
      {problem ? (
        <p className="pay-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}
