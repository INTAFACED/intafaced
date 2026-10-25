import { useState } from 'react';
import { myRewardsSchema } from '@intafaced/contracts/campaigns-catalogue';
import { Failure, Loading } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { displayAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import { useHoldings } from './holdings';
import { checkAmount } from './withdraw-model';
import { withdrawalCopy } from './withdrawal-copy';
import './bank-depth.css';

const AMOUNT_ERROR = { invalid: 'fAmountInvalid', zero: 'fAmountZero', tooMuch: 'fAmountTooMuch', unknown: 'fBalanceUnknown' } as const;

/**
 * The whole "send money out" form, shown first on `/uc/withdraw`: asset, network, where to, amount against the real
 * available balance, the fee line, and a review. Nothing here can be sent: sending out is not connected, so the review
 * button is off and says so beside it. The choices are real (the customer's own balances); no network, saved address or
 * fee is invented, because no read for them exists.
 */
export function WithdrawForm() {
  const { t } = withdrawalCopy.useCopy();
  const { hideBalances } = usePreferences();
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
                onChange={(event) => setAddress(event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="withdraw-new-hint"
              />
              <small id="withdraw-new-hint">{t('fNewHint')}</small>
            </label>
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
          {asset && <LockedRewards asset={asset} hidden={hideBalances} shown={shown} />}
          {available !== null && !hideBalances && (
            <div>
              <button type="button" className="bd-link" onClick={() => setAmount(available)}>
                {t('fMax')}
              </button>
            </div>
          )}
          <dl className="bd-facts">
            <Fact label={t('fFee')}>{t('fFeeValue')}</Fact>
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
          <Fact label={t('rNetwork')}>{notChosen}</Fact>
          <Fact label={t('rTo')}>
            {address.trim() ? (
              <span lang="und" data-withdrawal-private>
                {address.trim()}
              </span>
            ) : (
              notChosen
            )}
          </Fact>
          <Fact label={t('rFee')}>{t('fFeeValue')}</Fact>
        </dl>
        <DisabledAction variant="primary" label={t('fReview')} reason={t('fReason')} />
      </DepthPanel>
    </div>
  );
}

/**
 * Campaign rewards locked or given as a bonus in this asset (CM-rewards-hub-02): never in the available balance, so they
 * cannot be sent out. Read from the campaigns service each visit; a failed read says so and shows no number, and hidden
 * balances hide this one too.
 */
function LockedRewards({ asset, hidden, shown }: { asset: string; hidden: boolean; shown: (value: string) => string }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const mine = useResource((signal) => api.query('campaigns', 'rewards.mine', {}, myRewardsSchema, { signal }), 'withdraw-locked-rewards');
  const r = mine.resource;
  if (r.status === 'loading') return null;
  if (r.status === 'failed') {
    return (
      <p className="muted" data-testid="withdraw-locked-rewards" data-state="failed">
        {t('fLockedUnread')}
      </p>
    );
  }
  const line = r.data.totals.find((l) => l.status === 'locked' && l.asset === asset);
  if (!line) return null;
  return (
    <p
      className="muted"
      data-testid="withdraw-locked-rewards"
      data-state="ready"
      data-amount={hidden ? undefined : line.amount}
      data-asset={asset}
    >
      {t('fLocked', { amount: shown(line.amount), asset })}{' '}
      <a className="text-link" href="/uc/promotion">
        {t('fLockedLink')}
      </a>
    </p>
  );
}
