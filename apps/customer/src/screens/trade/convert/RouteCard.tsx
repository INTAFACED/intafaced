import { useMemo, useState } from 'react';
import { AssetIcon, Button } from '@intafaced/ui/lit';
import { DecimalInput } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../features/session/session';
import { createToolApi } from '../../../features/trade/tool-api';
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
    <section data-testid="cvt-card" className="lt-stack" aria-label={t('Convert')}>
      <div data-testid="cvt-card__head" className="lt-toolbar">
        <h2>{t('Convert')}</h2>
      </div>
      <div className="lt-stack">
        <div className="lt-stack" data-testid="from-field">
          <span className="lt-hint">{t('From')}</span>
          <div className="lt-toolbar">
            <span className="lt-toolbar">
              <AssetIcon asset={from} size="md" />
              <span>{from}</span>
            </span>
            <div className="lt-field">
              <DecimalInput aria-label={t('Amount to convert')} value={amount} onValueChange={setAmount} precision={2} placeholder="0" />
            </div>
          </div>
        </div>
        <div className="lt-stack" data-testid="to-field">
          <span className="lt-hint">{t('To')}</span>
          <div className="lt-toolbar">
            <span className="lt-toolbar">
              <AssetIcon asset={to} size="md" />
              <span>{to}</span>
            </span>
          </div>
        </div>
      </div>
      {route.status === 'loading' ? (
        <p className="lt-hint" role="status">
          {t('Route checking', { from, to })}
        </p>
      ) : null}
      {route.status === 'refused' ? (
        <div className="lt-refusal" data-refusal="refused" role="alert" data-testid="cvt-route-refused" data-code={route.code}>
          <p className="lt-refusal-body">
            <strong>{route.code === 'trade.convert_two_leg_unbuilt' ? t('Two leg title') : t('Route unlisted title')}.</strong>{' '}
            {route.code === 'trade.convert_two_leg_unbuilt' ? t('Two leg body', { from, to }) : t('Route unlisted body', { from, to })}
          </p>
        </div>
      ) : null}
      {route.status === 'unread' ? (
        <p className="lt-refusal" data-refusal="unreachable" role="alert">
          {t('Route unread', { from, to })}
        </p>
      ) : null}
      <Button tone="primary" size="lg" block disabled>
        {t('Preview conversion')}
      </Button>
      <a className="lt-link" href="/trade/convert" data-testid="cvt-route-other">
        {t('Choose other coins')}
      </a>
    </section>
  );
}
