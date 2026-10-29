import { useId, useState } from 'react';
import { Button, Dialog, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { networkLabel } from '../blockers';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import { useWallet } from '../wallet/WalletProvider';
import { swapCopy } from './copy';
import { keepMode, readMode, type SwapMode } from './mode';

/** A token the pools on the app's network trade. The list is read from the pools; none is invented here. */
export interface SwapToken {
  address: string;
  symbol: string;
  name: string;
}

/**
 * The /dex swap form (D-swap-10): token in, token out and the amount, in Simple or Manual mode. Simple hides the route
 * and slippage controls; Manual shows them after a one-time notice, and the choice is remembered in this browser when it
 * can be. The person's wallet signs every swap. With no pool reader connected the token lists are empty and Swap stays
 * off with the reason in words, never a made-up price.
 */
export function SwapForm({ tokens = [] }: { tokens?: readonly SwapToken[] }) {
  const { language } = usePreferences();
  const { t } = swapCopy.forLocale(language);
  const wallet = useWallet();
  const network = networkLabel(APP_CHAIN_ID).name;
  const [kept] = useState(readMode);
  const [mode, setMode] = useState<SwapMode>(kept.mode);
  const [manualSeen, setManualSeen] = useState(kept.manualSeen);
  const [notice, setNotice] = useState(false);
  const [tokenIn, setTokenIn] = useState('');
  const [tokenOut, setTokenOut] = useState('');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('');
  const ids = { pay: useId(), receive: useId(), note: useId() };

  const choose = (next: SwapMode) => {
    setMode(next);
    if (next === 'manual' && !manualSeen) setNotice(true);
    else keepMode(next, manualSeen);
  };
  const closeNotice = (accepted: boolean) => {
    setNotice(false);
    if (accepted) {
      setManualSeen(true);
      keepMode('manual', true);
    } else setMode('simple');
  };

  const reason =
    wallet.status !== 'connected'
      ? t('needsWallet')
      : !tokenIn || !tokenOut
        ? t('needsTokens')
        : tokenIn === tokenOut
          ? t('sameToken')
          : !/^\d{1,30}(\.\d{1,18})?$/.test(amount.trim()) || /^0*(\.0*)?$/.test(amount.trim())
            ? t('needsAmount')
            : t('needsQuote');

  const tokenSelect = (id: string, label: string, value: string, set: (value: string) => void) => (
    <label className="field">
      <span id={id}>{label}</span>
      <select value={value} onChange={(event) => set(event.target.value)} aria-labelledby={id} aria-describedby={ids.note}>
        <option value="">{t('chooseToken')}</option>
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {token.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Panel title={t('formTitle')}>
      <p className="muted">{t('formNote', { network })}</p>
      <form aria-label={t('formTitle')} className="protocol-quote" onSubmit={(event) => event.preventDefault()}>
        <div role="radiogroup" aria-label={t('mode')} className="protocol-actions">
          {(['simple', 'manual'] as const).map((entry) => (
            <label key={entry} className="field field--check">
              <input type="radio" name="swap-mode" value={entry} checked={mode === entry} onChange={() => choose(entry)} />
              <span>{t(entry)}</span> <small className="muted">{t(entry === 'simple' ? 'simpleHint' : 'manualHint')}</small>
            </label>
          ))}
        </div>
        {tokenSelect(ids.pay, t('youPay'), tokenIn, setTokenIn)}
        {tokenSelect(ids.receive, t('youReceive'), tokenOut, setTokenOut)}
        {tokens.length === 0 && (
          <p className="muted" id={ids.note}>
            {t('noTokens', { network })}
          </p>
        )}
        <Field
          label={t('amountIn')}
          hint={t('amountHint')}
          inputMode="decimal"
          value={amount}
          autoComplete="off"
          onChange={(event) => setAmount(event.target.value)}
        />
        {mode === 'manual' && (
          <>
            <Field
              label={t('slippage')}
              hint={t('slippageHint')}
              inputMode="decimal"
              value={slippage}
              autoComplete="off"
              onChange={(event) => setSlippage(event.target.value)}
            />
            <Button variant="secondary" disabled aria-disabled="true" title={t('routeNeedsQuote')}>
              {t('routeOptions')}
            </Button>
            <p className="muted">{t('routeNeedsQuote')}</p>
          </>
        )}
        <Button type="submit" disabled aria-disabled="true">
          {t('swap')}
        </Button>
        <p className="protocol-actions__reason" role="note" data-swap-reason>
          {reason}
        </p>
      </form>
      {notice && (
        <Dialog title={t('manualTitle')} onClose={() => closeNotice(false)}>
          <p>{t('manualBody')}</p>
          <Button onClick={() => closeNotice(true)}>{t('manualAccept')}</Button>
        </Dialog>
      )}
    </Panel>
  );
}
