import { useState } from 'react';
import './buy.css';
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

/** Simple Buy / Sell (UI-SPEC 5.9): breadcrumb, headline on the left, the BuyCard on the right. */
export default function TradeBuyScreen({ search }: ScreenProps) {
  const { t } = buyCopy.useCopy();
  const { asset, side: initialSide } = readSearch(search);
  const [side, setSide] = useState(initialSide);
  const selling = side === 'sell';
  return (
    <div data-testid="if-buy" className="if-buy">
      <nav data-testid="buy-crumbs" className="buy-crumbs" aria-label={selling ? t('Sell crypto') : t('Buy crypto')}>
        <a href="/trade">{t('Trade')}</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{selling ? t('Sell crypto') : t('Buy crypto')}</span>
        <a data-testid="buy-crumbs__history" className="buy-crumbs__history" href={ORDERS_HREF}>
          {t('Order history')}
        </a>
      </nav>
      <EmailProofNotice />
      <div className="buy-grid">
        <header data-testid="buy-hero" className="buy-hero">
          <h1>{selling ? t('Sell crypto in a few steps') : t('Buy crypto in a few steps')}</h1>
          <p>{selling ? t('Sell crypto intro') : t('Buy crypto intro')}</p>
        </header>
        <BuyCard initialAsset={asset} initialSide={initialSide} onAssetChange={undefined} onSideChange={setSide} />
      </div>
      <YourOrders />
    </div>
  );
}
