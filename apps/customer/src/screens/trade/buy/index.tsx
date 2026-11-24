// volt-room: /trade/buy
import { useState } from 'react';
import { FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { BuyCard, ORDERS_HREF } from './BuyCard';
import { buyCopy } from './copy';
import { YourOrders } from './YourOrders';
import { EmailProofNotice } from '../../../features/account/EmailProofNotice';
import { usePreferences } from '../../../shared/preferences';
import { LinkButton } from '../kit-parts';
import type { ScreenProps } from '../../../app/screen-types';

const READY: RoomState = { kind: 'ready' };

/** `?asset=BTC` picks the coin; `?side=sell` opens on Sell. Anything else is ignored. */
function readSearch(search: string): { asset: string | null; side: 'buy' | 'sell' } {
  const query = new URLSearchParams(search);
  const asset = query.get('asset')?.trim().toUpperCase() ?? '';
  return { asset: /^[A-Z0-9]{2,12}$/.test(asset) ? asset : null, side: query.get('side') === 'sell' ? 'sell' : 'buy' };
}

/** Simple Buy / Sell (UI-SPEC 5.9): breadcrumb, headline, the BuyCard and recent orders on Volt's FlowTemplate. */
export default function TradeBuyScreen({ search }: ScreenProps) {
  const { t } = buyCopy.useCopy();
  const { layoutMode } = usePreferences();
  const { asset, side: initialSide } = readSearch(search);
  const [side, setSide] = useState(initialSide);
  const selling = side === 'sell';
  return (
    <div data-testid="if-buy">
      <FlowTemplate
        title={selling ? t('Sell crypto in a few steps') : t('Buy crypto in a few steps')}
        description={selling ? t('Sell crypto intro') : t('Buy crypto intro')}
        headingMarks={{ 'data-testid': 'buy-hero' }}
        state={READY}
        mode={layoutMode === 'pro' ? 'pro' : 'simple'}
        roomAction={
          <LinkButton data-testid="buy-crumbs__history" href={ORDERS_HREF}>
            {t('Order history')}
          </LinkButton>
        }
        section={
          <nav data-testid="buy-crumbs" className="lt-row" aria-label={selling ? t('Sell crypto') : t('Buy crypto')}>
            <a className="lt-link" href="/trade">
              {t('Trade')}
            </a>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{selling ? t('Sell crypto') : t('Buy crypto')}</span>
          </nav>
        }
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
