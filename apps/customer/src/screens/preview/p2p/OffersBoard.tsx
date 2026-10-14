import { useMemo, useState } from 'react';
import { BadgeCheck, Star } from 'lucide-react';
import {
  AmountInput,
  Checkbox,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StateBlock,
  ToggleGroup,
  ToggleGroupItem,
} from '@intafaced/ui';
import { compareDecimal } from '../../../data/decimal';
import { PreviewActionButton, PreviewChip } from '../../../preview';
import {
  p2pFixture,
  type P2pAdvertiser,
  type P2pAssetId,
  type P2pFiatId,
  type P2pMethodId,
  type P2pSide,
} from '../../../preview/fixtures/p2p';
import { p2pCopy } from './copy';
import { coinText, countText, fiatText, pctText } from './format';

const { advertisers, fiats, methods, offers, assets } = p2pFixture.rows;
const advertiserById = new Map(advertisers.map((advertiser) => [advertiser.id, advertiser]));
const methodName = new Map(methods.map((method) => [method.id, method.name]));
const fiatById = new Map(fiats.map((fiat) => [fiat.id, fiat]));

function Badge({ badge }: { badge: P2pAdvertiser['badge'] }) {
  const { t } = p2pCopy.useCopy();
  if (badge === 'none') return null;
  return (
    <span className={`pv-p2p__badge pv-p2p__badge--${badge}`} data-testid="p2p-badge">
      {badge === 'top' ? (
        <Star size={12} strokeWidth={2} aria-hidden="true" />
      ) : (
        <BadgeCheck size={12} strokeWidth={2} aria-hidden="true" />
      )}
      {badge === 'top' ? t('Badge top') : t('Badge verified')}
    </span>
  );
}

export function OffersBoard() {
  const { t } = p2pCopy.useCopy();
  const [side, setSide] = useState<P2pSide>('buy');
  const [asset, setAsset] = useState<P2pAssetId>('USDT');
  const [fiatId, setFiatId] = useState<P2pFiatId>('usd');
  const [method, setMethod] = useState<'any' | P2pMethodId>('any');
  const [merchantsOnly, setMerchantsOnly] = useState(false);
  const [amount, setAmount] = useState('');

  const fiat = fiatById.get(fiatId)!;
  const rows = useMemo(
    () =>
      offers.filter((offer) => {
        if (offer.side !== side || offer.asset !== asset || offer.fiat !== fiatId) return false;
        if (method !== 'any' && !offer.methods.includes(method)) return false;
        if (merchantsOnly && advertiserById.get(offer.advertiserId)?.badge === 'none') return false;
        if (amount !== '' && amount !== '.') {
          const below = compareDecimal(amount, offer.minFiat);
          const above = compareDecimal(amount, offer.maxFiat);
          if (below === -1 || above === 1) return false;
        }
        return true;
      }),
    [side, asset, fiatId, method, merchantsOnly, amount],
  );

  const methodItems: Record<string, string> = { any: t('Any method'), ...Object.fromEntries(methods.map((m) => [m.id, m.name])) };
  const fiatItems: Record<string, string> = Object.fromEntries(fiats.map((f) => [f.id, `${f.name} (${f.sign})`]));

  return (
    <section className="pv-p2p__panel" aria-labelledby="pv-p2p-offers-title" data-testid="p2p-offers">
      <div className="pv-p2p__panel-head">
        <h2 id="pv-p2p-offers-title" className="pv-p2p__h2">
          {t('Offers title')} <PreviewChip />
        </h2>
        <PreviewActionButton product="p2p" variant="secondary" size={32}>
          {t('Post an ad')}
        </PreviewActionButton>
      </div>
      <p className="pv-p2p__lede">{t('Offers lede')}</p>

      <div className="pv-p2p__filters">
        <div className="pv-p2p__field">
          <span className="pv-p2p__label">{t('Side label')}</span>
          <SegmentedControl
            aria-label={t('Side label')}
            size={40}
            value={side}
            onValueChange={(next) => setSide(next as P2pSide)}
            items={[
              { value: 'buy', label: t('Buy'), tone: 'up' },
              { value: 'sell', label: t('Sell'), tone: 'down' },
            ]}
          />
        </div>
        <div className="pv-p2p__field">
          <span className="pv-p2p__label">{t('Coin label')}</span>
          <ToggleGroup aria-label={t('Coin label')} value={asset} onValueChange={(next) => setAsset(next as P2pAssetId)}>
            {assets.map((coin) => (
              <ToggleGroupItem key={coin} value={coin}>
                {coin}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="pv-p2p__field">
          <span className="pv-p2p__label" id="pv-p2p-currency">
            {t('Currency label')}
          </span>
          <Select items={fiatItems} value={fiatId} onValueChange={(next) => next && setFiatId(next as P2pFiatId)}>
            <SelectTrigger aria-labelledby="pv-p2p-currency" className="pv-p2p__select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fiats.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name} ({f.sign})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="pv-p2p__field">
          <span className="pv-p2p__label" id="pv-p2p-method">
            {t('Payment label')}
          </span>
          <Select items={methodItems} value={method} onValueChange={(next) => next && setMethod(next as 'any' | P2pMethodId)}>
            <SelectTrigger aria-labelledby="pv-p2p-method" className="pv-p2p__select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t('Any method')}</SelectItem>
              {methods.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="pv-p2p__field pv-p2p__field--amount">
          <AmountInput
            label={t('Amount label')}
            unit={fiat.sign}
            value={amount}
            onValueChange={setAmount}
            precision={2}
            placeholder="0.00"
          />
        </div>
        <label className="pv-p2p__check">
          <Checkbox checked={merchantsOnly} onCheckedChange={(next) => setMerchantsOnly(next === true)} />
          <span>{t('Merchants only')}</span>
        </label>
      </div>

      <p className="pv-p2p__legend">
        <span className="pv-p2p__badge pv-p2p__badge--top">
          <Star size={12} strokeWidth={2} aria-hidden="true" />
          {t('Badge top')}
        </span>
        <span>{t('Legend top')}</span>
        <span className="pv-p2p__badge pv-p2p__badge--verified">
          <BadgeCheck size={12} strokeWidth={2} aria-hidden="true" />
          {t('Badge verified')}
        </span>
        <span>{t('Legend verified')}</span>
      </p>

      {rows.length === 0 ? (
        <StateBlock kind="empty" title={t('Empty title')} body={t('Empty body')} />
      ) : (
        <div className="pv-p2p__scroll">
          <table className="pv-p2p__table">
            <thead>
              <tr>
                <th scope="col">{t('Column advertiser')}</th>
                <th scope="col">{t('Column price')}</th>
                <th scope="col">{t('Column available')}</th>
                <th scope="col">{t('Column payment')}</th>
                <th scope="col">
                  <span className="pv-p2p__sr">{side === 'buy' ? t('Buy') : t('Sell')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((offer) => {
                const advertiser = advertiserById.get(offer.advertiserId)!;
                return (
                  <tr key={offer.id} data-testid="p2p-offer">
                    <td>
                      <div className="pv-p2p__who">
                        <span className="pv-p2p__avatar" aria-hidden="true">
                          {advertiser.name.charAt(0).toUpperCase()}
                        </span>
                        <div className="pv-p2p__who-text">
                          <span className="pv-p2p__name">
                            {advertiser.name}
                            <Badge badge={advertiser.badge} />
                          </span>
                          <span className="pv-p2p__stats">
                            {t('Advertiser stats', {
                              trades: countText(advertiser.trades),
                              pct: pctText(advertiser.completionPct),
                              minutes: advertiser.releaseMinutes,
                            })}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="pv-p2p__num pv-p2p__price">{fiatText(fiat, offer.price, offer.priceTick)}</td>
                    <td className="pv-p2p__num">
                      <span className="pv-p2p__strong">
                        {t('Available line', { amount: coinText(offer.available), coin: offer.asset })}
                      </span>
                      <span className="pv-p2p__stats">
                        {t('Limit line', { min: fiatText(fiat, offer.minFiat, '0.01'), max: fiatText(fiat, offer.maxFiat, '0.01') })}
                      </span>
                    </td>
                    <td>
                      <span className="pv-p2p__methods">
                        {offer.methods.map((id) => (
                          <span key={id} className="pv-p2p__method">
                            {methodName.get(id)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="pv-p2p__action">
                      <PreviewActionButton product="p2p" variant={side === 'buy' ? 'buy' : 'sell'} size={32}>
                        {side === 'buy' ? t('Buy coin', { coin: offer.asset }) : t('Sell coin', { coin: offer.asset })}
                      </PreviewActionButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pv-p2p__foot">{t('Escrow note')}</p>
    </section>
  );
}
