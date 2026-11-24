// volt-room: /trade/buy
import { useState } from 'react';
import { FlowTemplate, RoomBar } from '@intafaced/ui/lit/templates';
import { EmailProofNotice } from '../../../features/account/EmailProofNotice';
import type { ScreenProps } from '../../../app/screen-types';
import { LinkButton } from '../kit-parts';
import { BuyCard, ORDERS_HREF } from './BuyCard';
import { buyCopy } from './copy';
import { YourOrders } from './YourOrders';

/** `?asset=BTC` picks the coin; `?side=sell` opens on Sell. Anything else is ignored. */
function readSearch(search: string): { asset: string | null; side: 'buy' | 'sell' } {
  const query = new URLSearchParams(search);
  const asset = query.get('asset')?.trim().toUpperCase() ?? '';
  return { asset: /^[A-Z0-9]{2,12}$/.test(asset) ? asset : null, side: query.get('side') === 'sell' ? 'sell' : 'buy' };
}

/** Simple Buy / Sell (UI-SPEC 5.9): breadcrumb, headline, the BuyCard and recent orders. */
export default function TradeBuyScreen({ search }: ScreenProps) {
  const { t } = buyCopy.useCopy();
  const { asset, side: initialSide } = readSearch(search);
  const [side, setSide] = useState(initialSide);
  const selling = side === 'sell';
  return (
    <div data-testid="if-buy" className="lt-stack">
      <FlowTemplate
        title={selling ? t('Sell crypto in a few steps') : t('Buy crypto in a few steps')}
        description={selling ? t('Sell crypto intro') : t('Buy crypto intro')}
        headingMarks={{ 'data-testid': 'buy-hero' }}
        bar={
          <RoomBar marks={{ 'data-testid': 'buy-crumbs' }}>
            <nav className="lt-toolbar" aria-label={selling ? t('Sell crypto') : t('Buy crypto')}>
              <a className="lt-link" href="/trade">
                {t('Trade')}
              </a>
              <span aria-hidden="true">›</span>
              <span aria-current="page">{selling ? t('Sell crypto') : t('Buy crypto')}</span>
            </nav>
            <LinkButton tone="secondary" data-testid="buy-crumbs__history" href={ORDERS_HREF}>
              {t('Order history')}
            </LinkButton>
          </RoomBar>
        }
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack">
            <EmailProofNotice />
            <BuyCard initialAsset={asset} initialSide={initialSide} onAssetChange={undefined} onSideChange={setSide} />
          </div>
        }
        summary={<YourOrders />}
      />
    </div>
  );
}
