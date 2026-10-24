import { useState } from 'react';
import { Button, Failure, Loading } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import { useHoldings } from './holdings';
import { INTERNAL_RAIL, useWithdrawDestination, type DestinationRead } from './withdraw-destination';
import { checkAmount } from './withdraw-model';
import { withdrawalSchema, type WithdrawalRecord } from './withdrawal-reads';
import { withdrawalCopy } from './withdrawal-copy';
import { WithdrawStepUp } from './WithdrawStepUp';
import './bank-depth.css';

const AMOUNT_ERROR = { invalid: 'fAmountInvalid', zero: 'fAmountZero', tooMuch: 'fAmountTooMuch', unknown: 'fBalanceUnknown' } as const;

type Copy = ReturnType<typeof withdrawalCopy.useCopy>['t'];

/** What the form says about where the typed address leads, or nothing for an address outside INTAFACED. */
function DestinationNote({ place, t }: { place: DestinationRead; t: Copy }) {
  if (place.state === 'idle' || (place.state === 'known' && place.kind === 'external')) return null;
  const kind = place.state === 'known' ? place.kind : place.state;
  const words =
    place.state === 'checking'
      ? t('dChecking')
      : place.state === 'failed'
        ? t('dFailed')
        : place.kind === 'internal'
          ? t('dInternal')
          : place.kind === 'self'
            ? t('dSelf')
            : place.kind === 'unavailable'
              ? t(place.reason === 'frozen' ? 'dFrozen' : place.reason === 'expired' ? 'dExpired' : 'dAmbiguous')
              : null;
  const refused = place.state === 'known' && (place.kind === 'self' || place.kind === 'unavailable');
  return (
    <div
      className={refused ? 'failure' : 'bd-address'}
      role={refused ? 'alert' : 'status'}
      data-testid="withdraw-destination"
      data-kind={kind}
    >
      {place.state === 'known' && place.kind === 'internal' && <strong>{t('dInternalTitle')}</strong>}
      <p>{words}</p>
    </div>
  );
}

/**
 * The whole "send money out" form, shown first on `/uc/withdraw`: asset, network, where to, amount against the real
 * available balance, the fee line, and a review. Sending to a wallet, card or bank outside INTAFACED is not connected, so
 * for those the review button is off and says so beside it. An address that belongs to another INTAFACED account
 * (W-withdraw-14) is the one send that works: the form says it settles inside at once with no fee, and after a fresh
 * confirmation svc-pay settles it as one transfer. Its client reference is kept while the answer is unknown, so confirming
 * again finishes the same withdrawal and never sends twice. The choices are real (the customer's own balances); no network,
 * saved address or fee is invented.
 */
export function WithdrawForm() {
  const { t } = withdrawalCopy.useCopy();
  const { hideBalances } = usePreferences();
  const { api } = useSession();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const [picked, setPicked] = useState('');
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const asset = assets.some((entry) => entry.assetId === picked) ? picked : (assets[0]?.assetId ?? '');
  const available = assets.find((entry) => entry.assetId === asset)?.available ?? null;
  const check = checkAmount(amount, available);
  // While balances load there is nothing to say yet; once they fail or come back empty the amount cannot be judged.
  const problem =
    check in AMOUNT_ERROR && !(check === 'unknown' && held.resource.status === 'loading')
      ? t(AMOUNT_ERROR[check as keyof typeof AMOUNT_ERROR])
      : undefined;
  const shown = (value: string) => (hideBalances ? '••••' : displayAmount(value));
  const notChosen = t('rNotChosen');
  const place = useWithdrawDestination(address);
  const inside = place.state === 'known' && place.kind === 'internal';
  // The withdrawal being sent: its terms and its client reference. Kept until svc-pay gives a final answer, so a send whose
  // answer was lost is finished by confirming again with the same reference.
  const terms = JSON.stringify([asset, amount.trim(), address.trim()]);
  const [open, setOpen] = useState<{ terms: string; clientRef: string; unanswered: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<WithdrawalRecord | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const resuming = open !== null && open.terms === terms && open.unanswered;
  const canSend = inside && check === 'ok' && Boolean(asset);

  function startSend() {
    if (!canSend) return;
    setRefusal(null);
    setSent(null);
    if (!open || open.terms !== terms) setOpen({ terms, clientRef: `internal-${crypto.randomUUID()}`, unanswered: false });
    setConfirming(true);
  }

  async function sendInside(token: string, clientRef: string) {
    const answer = await api.mutate(
      'pay',
      'withdrawal.create',
      { assetId: asset, amount: amount.trim(), railId: INTERNAL_RAIL, destination: { kind: 'crypto', ref: address.trim() }, clientRef },
      withdrawalSchema,
      { bearer: token },
    );
    if (answer.ok) {
      setSent(answer.data);
      setOpen(null);
      held.reload();
      return answer;
    }
    // A named refusal from svc-pay is final: nothing moved, the dialog closes and the form says why. A new send is a new one.
    if (answer.code?.startsWith('pay.') && answer.code !== 'pay.rail_outcome_unknown') {
      setRefusal(answer.code === 'pay.withdrawal_self_send' ? t('dSelf') : `${t('sRefused')} ${t('sReference', { code: answer.code })}`);
      setOpen(null);
      return { ok: true as const, data: null };
    }
    // No answer, or svc-pay does not know yet: the send may have happened. Keep the reference so confirming again finishes it.
    setOpen((now) => (now && now.clientRef === clientRef ? { ...now, unanswered: true } : now));
    return { ...answer, message: t('sUnknown') };
  }
  return (
    <div className="bd-stack" data-testid="withdraw-form">
      <DepthPanel title={t('formTitle')} lead={t('formLead')}>
        <div className="bd-address" role="status">
          <strong>{t('unavailable')}</strong>
          <p>{t('unavailableNote')}</p>
        </div>
        <form className="bd-stack" onSubmit={(event) => event.preventDefault()} noValidate>
          {held.resource.status === 'loading' ? (
            <Loading />
          ) : held.resource.status === 'failed' ? (
            <Failure result={held.resource.failure} retry={held.reload} />
          ) : (
            <label className="field">
              <span>{t('fAsset')}</span>
              <select value={asset} onChange={(event) => setPicked(event.target.value)} disabled={assets.length === 0}>
                {assets.length === 0 && <option value="">—</option>}
                {assets.map((entry) => (
                  <option key={entry.assetId} value={entry.assetId}>
                    {entry.assetId}
                  </option>
                ))}
              </select>
              <small>{assets.length === 0 ? t('fNoAssets') : t('fAssetHint')}</small>
            </label>
          )}
          <label className="field">
            <span>{t('fNetwork')}</span>
            <select disabled aria-describedby="withdraw-network-why">
              <option>{t('fNetworkNone')}</option>
            </select>
            <small id="withdraw-network-why">{t('fNetworkWhy')}</small>
          </label>
          <fieldset className="bd-stack">
            <legend className="bd-subhead">{t('fWhere')}</legend>
            <label className="field">
              <span>{t('fSaved')}</span>
              <select disabled aria-describedby="withdraw-saved-why">
                <option>{t('fSavedNone')}</option>
              </select>
              <small id="withdraw-saved-why">
                {t('fSavedWhy')}{' '}
                <a className="text-link" href="/uc/withdraw/address">
                  {t('fManage')}
                </a>
              </small>
            </label>
            <label className="field">
              <span>{t('fNew')}</span>
              <input
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setRefusal(null);
                }}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="withdraw-new-hint"
              />
              <small id="withdraw-new-hint">{t('fNewHint')}</small>
            </label>
            <DestinationNote place={place} t={t} />
          </fieldset>
          <label className="field">
            <span>{t('fAmount')}</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              autoComplete="off"
              aria-invalid={Boolean(problem)}
              aria-describedby="withdraw-amount-help"
            />
            <small id="withdraw-amount-help" className={problem ? 'error-text' : ''}>
              {problem ?? (available !== null && asset ? t('fAvailable', { amount: shown(available), asset }) : undefined)}
            </small>
          </label>
          {available !== null && !hideBalances && (
            <div>
              <button type="button" className="bd-link" onClick={() => setAmount(available)}>
                {t('fMax')}
              </button>
            </div>
          )}
          <dl className="bd-facts">
            <Fact label={t('fFee')}>{inside ? t('rNoFee') : t('fFeeValue')}</Fact>
          </dl>
        </form>
      </DepthPanel>
      <DepthPanel title={t('fReviewTitle')} lead={t('fReviewLead')}>
        <dl className="bd-facts" data-testid="withdraw-review">
          <Fact label={t('rSend')}>
            {check === 'ok' && asset ? (
              <span className="numeric" lang="und">
                {shown(amount.trim())} {asset}
              </span>
            ) : (
              notChosen
            )}
          </Fact>
          <Fact label={t('rNetwork')}>{inside ? t('rInside') : notChosen}</Fact>
          <Fact label={t('rTo')}>
            {address.trim() ? (
              <span lang="und" data-withdrawal-private>
                {address.trim()}
              </span>
            ) : (
              notChosen
            )}
          </Fact>
          <Fact label={t('rFee')}>{inside ? t('rNoFee') : t('fFeeValue')}</Fact>
        </dl>
        {canSend ? (
          <div className="bd-stack">
            {resuming && (
              <p className="money-caption" role="status">
                {t('sUnknown')}
              </p>
            )}
            <div className="actions">
              <Button variant="primary" onClick={startSend}>
                {resuming ? t('sFinish') : t('sSend')}
              </Button>
            </div>
          </div>
        ) : (
          <DisabledAction
            variant="primary"
            label={inside ? t('sSend') : t('fReview')}
            reason={inside ? t('sNeedAmount') : t('fReason')}
          />
        )}
        {refusal && (
          <p className="failure" role="alert" data-testid="withdraw-refusal">
            {refusal}
          </p>
        )}
        {sent && (
          <div className="bd-address" role="status" data-testid="withdraw-outcome" data-status={sent.status}>
            <strong>{t('sDoneTitle')}</strong>
            <p>{t('sDone', { amount: shown(sent.amount), asset: sent.assetId })}</p>
            <a className="text-link" href={`/uc/withdraw/${sent.id}`}>
              {t('sOpen')}
            </a>
          </div>
        )}
      </DepthPanel>
      {confirming && open && (
        <WithdrawStepUp
          why={t('sWhy', { amount: shown(amount.trim()), asset })}
          run={(token) => sendInside(token, open.clientRef)}
          onDone={() => setConfirming(false)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
