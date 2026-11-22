import { useMemo, useState } from 'react';
import { Button, CoinMark, DecimalField } from '@intafaced/ui/lit';
import { createToolApi, useSession } from '../buy/deps';
import { convertCopy } from './copy';
import { useConvertRoute } from './use-pairs';

/**
 * The Convert card for a pair no market joins (J-cex-spot-11 #11), such as a cash currency to a coin. The service says
 * how the two convert (`convert.route`); where that needs two linked legs through a coin, which are not built, it refuses
 * by name and this card shows that refusal with its code. Nothing is priced and nothing can be sent from here.
 */
export function RouteCard({ from, to }: { from: string; to: string }) {
  const { t } = convertCopy.useCopy();
  const { api } = useSession();
  const tools = useMemo(() => createToolApi(api), [api]);
  const route = useConvertRoute(tools, from, to);
  const [amount, setAmount] = useState('');

  return (
    <section data-testid="cvt-card" aria-label={t('Convert')}>
      <div data-testid="cvt-card__head" className="lt-title-row">
        <h2>{t('Convert')}</h2>
      </div>
      <div data-testid="from-field">
        <p className="lt-hint">{t('From')}</p>
        <div className="lt-toolbar">
          <CoinMark asset={from} size="sm" />
          <span>{from}</span>
          <DecimalField
            label={t('Amount to convert')}
            labelHidden
            size="hero"
            typedMark="either"
            value={amount}
            onValueChange={setAmount}
            precision={2}
            placeholder="0"
          />
        </div>
      </div>
      <div data-testid="to-field">
        <p className="lt-hint">{t('To')}</p>
        <div className="lt-toolbar">
          <CoinMark asset={to} size="sm" />
          <span>{to}</span>
        </div>
      </div>
      {route.status === 'loading' ? <p role="status">{t('Route checking', { from, to })}</p> : null}
      {route.status === 'refused' ? (
        <div role="alert" data-testid="cvt-route-refused" data-code={route.code}>
          <p>
            <strong>{route.code === 'trade.convert_two_leg_unbuilt' ? t('Two leg title') : t('Route unlisted title')}.</strong>{' '}
            {route.code === 'trade.convert_two_leg_unbuilt' ? t('Two leg body', { from, to }) : t('Route unlisted body', { from, to })}
          </p>
        </div>
      ) : null}
      {route.status === 'unread' ? <p role="alert">{t('Route unread', { from, to })}</p> : null}
      <Button tone="primary" size="lg" block disabled>
        {t('Preview conversion')}
      </Button>
      <div className="lt-actions">
        <a className="lt-link" href="/trade/convert" data-testid="cvt-route-other">
          {t('Choose other coins')}
        </a>
      </div>
    </section>
  );
}
