import { useState } from 'react';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { BuyCard, ORDERS_HREF } from './BuyCard';
import { buyCopy } from './copy';
import { YourOrders } from './YourOrders';
import { EmailProofNotice } from '../../../features/account/EmailProofNotice';
import type { ScreenProps } from '../../../app/screen-types';

/** `?asset=BTC` picks the coin; `?side=sell` opens on Sell. Anything else is ignored. */
function readSearch(search: string): { asset: string | null; side: 'buy' | 'sell' } {
  const query = new URLSearchParams(search);
  const asset = query.get('asset')?.trim().toUpperCase() ?? '';
  return { asset: /^[A-Z0-9]{2,12}$/.test(asset) ? asset : null, side: query.get('side') === 'sell' ? 'sell' : 'buy' };
}

/** Simple Buy / Sell (UI-SPEC 5.9) on the flow template: the headline, the breadcrumb and the BuyCard, your orders beside them. */
export default function TradeBuyScreen({ search }: ScreenProps) {
  const { t } = buyCopy.useCopy();
  const { asset, side: initialSide } = readSearch(search);
  const [side, setSide] = useState(initialSide);
  const selling = side === 'sell';
  return (
    <FlowTemplate
      title={selling ? t('Sell crypto in a few steps') : t('Buy crypto in a few steps')}
      description={selling ? t('Sell crypto intro') : t('Buy crypto intro')}
      state={{ kind: 'ready' }}
      roomAction={
        <a data-testid="buy-crumbs__history" className="lt-link" href={ORDERS_HREF}>
          {t('Order history')}
        </a>
      }
      step={
        <div data-testid="if-buy">
          <nav data-testid="buy-crumbs" className="lt-actions" aria-label={selling ? t('Sell crypto') : t('Buy crypto')}>
            <a className="lt-link" href="/trade">
              {t('Trade')}
            </a>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{selling ? t('Sell crypto') : t('Buy crypto')}</span>
          </nav>
          <EmailProofNotice />
          <BuyCard initialAsset={asset} initialSide={initialSide} onAssetChange={undefined} onSideChange={setSide} />
        </div>
      }
      summary={<YourOrders />}
    />
  );
}
