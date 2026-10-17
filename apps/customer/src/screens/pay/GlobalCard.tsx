import { useEffect, useMemo, useState } from 'react';
import { AmountInput, Button, createPersonalPayApi, useSession } from './deps';
import { personalCopy } from './personal-copy';
import { payCopy } from './copy';
import { Reason, sourceLabel, Steps, useSources } from './journey';

type Currency = { code: string; name: string };

/**
 * Send globally (/pay/global). The currency list is the real one the platform is configured for. No payment provider
 * and no exchange-rate source are connected, so the quote shows nothing rather than a guessed rate, and sending is off.
 */
export function GlobalCard() {
  const { t } = personalCopy.useCopy();
  const { api, userId } = useSession();
  const { sources, state } = useSources();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const [currencies, setCurrencies] = useState<'loading' | 'error' | Currency[]>('loading');
  useEffect(() => {
    const controller = new AbortController();
    void pay.fiat(controller.signal).then((result) => {
      if (!controller.signal.aborted) setCurrencies(result.ok ? result.data.map(({ code, name }) => ({ code, name })) : 'error');
    });
    return () => controller.abort();
  }, [pay]);
  return (
    <div className="pay-body" data-testid="global-card">
      <Reason title={t('globalReasonTitle')}>{t('globalReasonBody')}</Reason>
      <Steps
        items={[
          t('globalStepDestination'),
          t('globalStepRecipient'),
          t('globalStepAmount'),
          t('globalStepQuote'),
          t('globalStepReview'),
          t('globalStepTrack'),
        ]}
      />
      <form className="pay-body" noValidate onSubmit={(event) => event.preventDefault()}>
        <div className="pay-field">
          <label className="pay-field__label" htmlFor="global-currency">
            {t('theyReceiveIn')}
          </label>
          <select id="global-currency" className="pay-text" defaultValue="" disabled>
            <option value="">
              {currencies === 'loading' ? t('currenciesLoading') : currencies === 'error' ? t('currenciesFailed') : t('currencyPick')}
            </option>
            {Array.isArray(currencies)
              ? currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} · {currency.name}
                  </option>
                ))
              : null}
          </select>
        </div>
        <fieldset className="pay-fieldset" disabled>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-name">
              {t('recipientName')}
            </label>
            <input id="global-name" className="pay-text" type="text" autoComplete="off" />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-account">
              {t('recipientAccount')}
            </label>
            <input id="global-account" className="pay-text" type="text" autoComplete="off" />
          </div>
          <div className="pay-field">
            <label className="pay-field__label" htmlFor="global-bank">
              {t('recipientBankCode')}
            </label>
            <input id="global-bank" className="pay-text" type="text" autoComplete="off" />
          </div>
          <div className="pay-field">
            <span className="pay-field__label">{t('youSend')}</span>
            <AmountInput aria-label={t('youSend')} value="" onValueChange={() => {}} precision={18} placeholder="0" disabled />
            <select className="pay-text" aria-label={payCopy.t('Asset to send')} defaultValue="">
              {sources.length === 0 ? <option value="">{state === 'loading' ? '…' : ''}</option> : null}
              {sources.map((row) => (
                <option key={row.id} value={row.id}>
                  {sourceLabel(row)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <div>
          <h3 className="pay-section-title">{t('quote')}</h3>
          <dl className="pay-quote" data-testid="global-quote">
            <div>
              <dt>{t('quoteRate')}</dt>
              <dd>—</dd>
            </div>
            <div>
              <dt>{t('quoteFee')}</dt>
              <dd>—</dd>
            </div>
            <div>
              <dt>{t('quoteReceive')}</dt>
              <dd>—</dd>
            </div>
            <div>
              <dt>{t('quoteArrives')}</dt>
              <dd>—</dd>
            </div>
          </dl>
          <p className="pay-hint">{t('quoteNone')}</p>
        </div>
        <Button type="submit" variant="primary" size={56} fullWidth disabled data-testid="global-review">
          {t('globalReviewOff')}
        </Button>
      </form>
      <div className="pay-block">
        <h3 className="pay-section-title">{t('globalStepTrack')}</h3>
        <Steps items={[t('trackSent'), t('trackOnItsWay'), t('trackArrived')]} />
      </div>
      <div className="pay-block">
        <h3 className="pay-section-title">{t('globalHistory')}</h3>
        <p className="pay-empty">{t('globalHistoryEmpty')}</p>
      </div>
    </div>
  );
}
