import './buy.css';
import { BuyCard, ACTIVITY_HREF } from './BuyCard';
import { buyCopy } from './copy';
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
  const { asset, side } = readSearch(search);
  return (
    <div className="if-buy">
      <nav className="buy-crumbs" aria-label={t('Buy crypto')}>
        <a href="/trade">{t('Trade')}</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{t('Buy crypto')}</span>
        <a className="buy-crumbs__history" href={ACTIVITY_HREF}>
          {t('Order history')}
        </a>
      </nav>
      <div className="buy-grid">
        <header className="buy-hero">
          <h1>{t('Buy crypto in a few steps')}</h1>
          <p>{t('Buy crypto intro')}</p>
        </header>
        <BuyCard initialAsset={asset} initialSide={side} onAssetChange={undefined} />
      </div>
    </div>
  );
}
