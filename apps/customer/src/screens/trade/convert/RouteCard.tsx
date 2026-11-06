import { useMemo, useState } from 'react';
import { AmountInput, Button, CoinIcon, createToolApi, useSession } from '../buy/deps';
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
    <section data-testid="cvt-card" className="cvt-card" aria-label={t('Convert')}>
      <div data-testid="cvt-card__head" className="cvt-card__head">
        <h2>{t('Convert')}</h2>
      </div>
      <div className="cvt-fields">
        <div className="cvt-field" data-testid="from-field">
          <span className="cvt-field__label">{t('From')}</span>
          <div className="cvt-field__main">
            <span className="cvt-asset">
              <CoinIcon asset={from} size={28} />
              <span>{from}</span>
            </span>
            <AmountInput
              size="hero"
              aria-label={t('Amount to convert')}
              value={amount}
              onValueChange={setAmount}
              precision={2}
              placeholder="0"
              className="cvt-amount"
            />
          </div>
        </div>
        <div className="cvt-field" data-testid="to-field">
          <span className="cvt-field__label">{t('To')}</span>
          <div className="cvt-field__main">
            <span className="cvt-asset">
              <CoinIcon asset={to} size={28} />
              <span>{to}</span>
            </span>
          </div>
        </div>
      </div>
      {route.status === 'loading' ? (
        <p className="cvt-rate cvt-rate--wait" role="status">
          {t('Route checking', { from, to })}
        </p>
      ) : null}
      {route.status === 'refused' ? (
        <div className="cvt-note" role="alert" data-testid="cvt-route-refused" data-code={route.code}>
          <p>
            <strong>{route.code === 'trade.convert_two_leg_unbuilt' ? t('Two leg title') : t('Route unlisted title')}.</strong>{' '}
            {route.code === 'trade.convert_two_leg_unbuilt' ? t('Two leg body', { from, to }) : t('Route unlisted body', { from, to })}
          </p>
        </div>
      ) : null}
      {route.status === 'unread' ? (
        <p className="cvt-note" role="alert">
          {t('Route unread', { from, to })}
        </p>
      ) : null}
      <Button variant="primary" size={56} fullWidth disabled>
        {t('Preview conversion')}
      </Button>
    </section>
  );
}
