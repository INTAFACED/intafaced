import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { Amount, AmountInput, CoinIcon, Money, Tabs, TabsList, TabsPanel, TabsTab, ToggleGroup, ToggleGroupItem } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { fmtAmount, fmtPctPoints, fmtUsd } from '../../../data/format';
import { PreviewActionButton, PreviewChip, PreviewScreen } from '../../../preview';
import { earnFixture, type EarnAsset, type EarnKind, type EarnPosition, type EarnProduct } from '../../../preview/fixtures/earn';
import { earnCopy } from './copy';
import { meetsMinimum, sampleReward, sumDecimals, worth } from './earn-math';
import './earn.css';

type KindFilter = 'all' | EarnKind;
type CoinFilter = 'all' | EarnAsset;
type TicketTab = 'subscribe' | 'redeem';

const sample = earnFixture.rows;
const coins = ['USDT', 'USDC', 'BTC', 'ETH', 'SOL'] as const satisfies readonly EarnAsset[];
const productById = new Map(sample.products.map((product) => [product.id, product]));

function showAmount(asset: EarnAsset, value: string | null): string {
  const places = sample.places[asset];
  return fmtAmount(value, { places, fixed: places === 2 });
}
const showUsd = (value: string | null) => fmtUsd(value);
const withUnit = (asset: EarnAsset, value: string | null) => (value === null ? '—' : `${showAmount(asset, value)} ${asset}`);

function positionStatus(position: EarnPosition, t: ReturnType<typeof earnCopy.useCopy>['t']): string {
  return position.endsInDays === null ? t('Any time') : t('Ends in days', { days: position.endsInDays });
}

export default function EarnPreview(_props: ScreenProps) {
  return (
    <PreviewScreen product="earn">
      <EarnBody />
    </PreviewScreen>
  );
}

function EarnBody() {
  const { t } = earnCopy.useCopy();
  const [kind, setKind] = useState<KindFilter>('all');
  const [coin, setCoin] = useState<CoinFilter>('all');
  const [selectedId, setSelectedId] = useState<string>('usdt-flex');
  const [ticketTab, setTicketTab] = useState<TicketTab>('subscribe');

  const visible = useMemo(
    () => sample.products.filter((p) => (kind === 'all' || p.kind === kind) && (coin === 'all' || p.asset === coin)),
    [kind, coin],
  );
  // If a filter hides the chosen product, the ticket falls back to the first visible one, so it never shows a stale choice.
  const selected = visible.find((p) => p.id === selectedId) ?? visible[0] ?? null;

  const totals = useMemo(() => {
    const valueOf = (amount: string, asset: EarnAsset) => worth(amount, sample.prices[asset]) ?? '0';
    const held = sample.positions.map((p) => ({ p, product: productById.get(p.productId)! }));
    return {
      inEarn: sumDecimals(held.map(({ p, product }) => valueOf(p.principal, product.asset))),
      collected: sumDecimals(held.map(({ p, product }) => valueOf(p.collected, product.asset))),
      perDay: sumDecimals(held.map(({ p, product }) => valueOf(sampleReward(p.principal, product.ratePct, 1) ?? '0', product.asset))),
    };
  }, []);

  return (
    <>
      <section className="ern-notice" role="note" aria-label={t('Notice title')} data-testid="earn-notice">
        <Info size={18} strokeWidth={1.75} aria-hidden="true" className="ern-notice__icon" />
        <div>
          <p className="ern-notice__title">{t('Notice title')}</p>
          <p className="ern-notice__body">{t('Notice body')}</p>
        </div>
      </section>

      <section className="ern-stats" aria-label={t('Stats label')}>
        <div className="ern-stat">
          <span className="ern-stat__label">{t('In Earn')}</span>
          <Money className="ern-stat__value" value={showUsd(totals.inEarn)} />
        </div>
        <div className="ern-stat">
          <span className="ern-stat__label">{t('Rewards collected')}</span>
          <Money className="ern-stat__value" value={showUsd(totals.collected)} />
        </div>
        <div className="ern-stat">
          <span className="ern-stat__label">{t('Rewards per day')}</span>
          <Money className="ern-stat__value" value={showUsd(totals.perDay)} />
        </div>
      </section>

      <div className="ern-grid">
        <section className="if-preview__panel ern-products" aria-labelledby="ern-products-h">
          <div className="if-preview__panel-head">
            <h2 className="if-preview__h2" id="ern-products-h">
              {t('Products')}
            </h2>
            <PreviewChip />
          </div>
          <div className="ern-filters">
            <Tabs value={kind} onValueChange={(next) => setKind(next as KindFilter)}>
              <TabsList divider aria-label={t('Kind filter')}>
                <TabsTab value="all">{t('All')}</TabsTab>
                <TabsTab value="flexible">{t('Flexible')}</TabsTab>
                <TabsTab value="locked">{t('Locked')}</TabsTab>
              </TabsList>
            </Tabs>
            <ToggleGroup value={coin} onValueChange={(next) => setCoin(next as CoinFilter)} aria-label={t('Coin filter')}>
              <ToggleGroupItem value="all">{t('All coins')}</ToggleGroupItem>
              {coins.map((asset) => (
                <ToggleGroupItem key={asset} value={asset}>
                  {asset}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="ern-list-head" aria-hidden="true">
            <span>{t('Coin')}</span>
            <span>{t('Type')}</span>
            <span className="ern-right">{t('Sample rate')}</span>
            <span className="ern-right">{t('Minimum')}</span>
          </div>
          {visible.length === 0 ? (
            <div className="ern-empty">
              <p>{t('No products')}</p>
              <button
                type="button"
                className="ern-link"
                onClick={() => {
                  setKind('all');
                  setCoin('all');
                }}
              >
                {t('Clear filters')}
              </button>
            </div>
          ) : (
            <div className="ern-list" role="radiogroup" aria-label={t('Product list')}>
              {visible.map((product) => (
                <ProductRow
                  key={product.id}
                  product={product}
                  active={selected?.id === product.id}
                  onPick={() => {
                    setSelectedId(product.id);
                    setTicketTab('subscribe');
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="if-preview__panel ern-ticket" aria-label={t('Ticket label')}>
          <Tabs value={ticketTab} onValueChange={(next) => setTicketTab(next as TicketTab)}>
            <TabsList divider>
              <TabsTab value="subscribe">{t('Subscribe')}</TabsTab>
              <TabsTab value="redeem">{t('Redeem')}</TabsTab>
            </TabsList>
            <TabsPanel value="subscribe" className="ern-ticket__body">
              {selected ? (
                <SubscribeForm key={selected.id} product={selected} />
              ) : (
                <p className="if-preview__note">{t('Pick a product')}</p>
              )}
            </TabsPanel>
            <TabsPanel value="redeem" className="ern-ticket__body">
              <RedeemForm />
            </TabsPanel>
          </Tabs>
        </aside>
      </div>

      <section className="if-preview__panel ern-positions" aria-labelledby="ern-positions-h">
        <div className="if-preview__panel-head">
          <h2 className="if-preview__h2" id="ern-positions-h">
            {t('Positions heading')}
          </h2>
          <PreviewChip />
        </div>
        <p className="if-preview__note">{t('Positions note')}</p>
        {sample.positions.length === 0 ? (
          <p className="if-preview__note">{t('No positions')}</p>
        ) : (
          <div className="ern-table-wrap">
            <table className="if-preview__table ern-table">
              <thead>
                <tr>
                  <th scope="col">{t('Position')}</th>
                  <th scope="col" className="ern-right">
                    {t('Put in')}
                  </th>
                  <th scope="col" className="ern-right">
                    {t('Collected')}
                  </th>
                  <th scope="col" className="ern-right">
                    {t('Sample rate')}
                  </th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col" className="ern-right">
                    <span className="ern-sr">{t('Action')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sample.positions.map((position) => {
                  const product = productById.get(position.productId)!;
                  const kindText = product.termDays === null ? t('Flexible') : t('Locked days', { days: product.termDays });
                  return (
                    <tr key={position.id}>
                      <th scope="row">
                        <span className="ern-coin">
                          <CoinIcon asset={product.asset} size={28} />
                          <span>
                            {product.asset}
                            <span className="ern-sub">{kindText}</span>
                          </span>
                        </span>
                      </th>
                      <td className="ern-right">
                        <Amount value={withUnit(product.asset, position.principal)} />
                      </td>
                      <td className="ern-right">
                        <Amount value={withUnit(product.asset, position.collected)} />
                      </td>
                      <td className="ern-right">
                        <RateText ratePct={product.ratePct} />
                      </td>
                      <td>{positionStatus(position, t)}</td>
                      <td className="ern-right">
                        <PreviewActionButton
                          product="earn"
                          variant="secondary"
                          size={28}
                          aria-label={t('Redeem row', { coin: product.asset, kind: kindText })}
                        >
                          {t('Redeem')}
                        </PreviewActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** A rate always carries the words "sample rate" right beside the number, so it can never be read as a real one. */
function RateText({ ratePct }: { ratePct: string }) {
  const { t } = earnCopy.useCopy();
  return (
    <span className="ern-rate" data-testid="sample-rate">
      <span className="ern-rate__num">{fmtPctPoints(ratePct, { signed: false })}</span>
      <span className="ern-rate__tag">{t('Rate sample label')}</span>
    </span>
  );
}

function ProductRow({ product, active, onPick }: { product: EarnProduct; active: boolean; onPick: () => void }) {
  const { t } = earnCopy.useCopy();
  const typeText = product.termDays === null ? t('Flexible any time') : t('Locked days', { days: product.termDays });
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className="ern-row"
      data-active={active || undefined}
      data-kind={product.kind}
      onClick={onPick}
    >
      <span className="ern-coin">
        <CoinIcon asset={product.asset} size={28} />
        <span>
          {product.asset}
          <span className="ern-sub">{sample.assetNames[product.asset]}</span>
        </span>
      </span>
      <span className="ern-type">{typeText}</span>
      <span className="ern-right">
        <RateText ratePct={product.ratePct} />
        <span className="ern-sub">{t('Per year')}</span>
      </span>
      <span className="ern-right ern-min">{withUnit(product.asset, product.minAmount)}</span>
    </button>
  );
}

function SubscribeForm({ product }: { product: EarnProduct }) {
  const { t } = earnCopy.useCopy();
  const [amount, setAmount] = useState('');
  const { asset } = product;
  const available = sample.available[asset];
  const belowMin = amount !== '' && !meetsMinimum(amount, product.minAmount);
  const usable = meetsMinimum(amount, product.minAmount) ? amount : null;

  const lines: { label: string; value: string }[] = [];
  if (product.termDays === null) {
    lines.push({ label: t('Per day'), value: withUnit(asset, usable && sampleReward(usable, product.ratePct, 1)) });
    lines.push({ label: t('Per 30 days'), value: withUnit(asset, usable && sampleReward(usable, product.ratePct, 30)) });
  } else {
    const atEnd = usable ? sampleReward(usable, product.ratePct, product.termDays) : null;
    lines.push({ label: t('Term'), value: t('Term days', { days: product.termDays }) });
    lines.push({ label: t('At end'), value: withUnit(asset, atEnd) });
    lines.push({ label: t('Total at end'), value: withUnit(asset, atEnd && usable ? sumDecimals([usable, atEnd]) : null) });
  }
  const dollars = usable ? showUsd(worth(usable, sample.prices[asset])) : null;

  return (
    <div className="ern-form">
      <div className="ern-chosen">
        <CoinIcon asset={asset} size={40} />
        <div>
          <p className="ern-chosen__name">
            {asset} · {product.termDays === null ? t('Flexible') : t('Locked days', { days: product.termDays })}
          </p>
          <p className="ern-chosen__rate">
            <RateText ratePct={product.ratePct} /> <span className="ern-sub ern-sub--inline">{t('Per year')}</span>
          </p>
        </div>
      </div>
      <p className="if-preview__note ern-rule">{product.termDays === null ? t('Flexible rule') : t('Locked rule')}</p>
      <AmountInput
        label={t('Amount')}
        unit={asset}
        value={amount}
        onValueChange={setAmount}
        precision={sample.places[asset]}
        maxLabel={t('Max')}
        onMax={() => setAmount(available)}
        error={belowMin ? t('Below minimum', { min: showAmount(asset, product.minAmount), asset }) : undefined}
      />
      <p className="ern-avail">
        <span>{t('Available sample')}</span>
        <Amount value={withUnit(asset, available)} />
      </p>
      <div className="ern-estimate" data-testid="earn-estimate">
        <p className="ern-estimate__title">{t('Sample estimate')}</p>
        <dl>
          <div>
            <dt>{t('Rate line')}</dt>
            <dd>
              <RateText ratePct={product.ratePct} />
            </dd>
          </div>
          {lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
        {dollars ? (
          <p className="ern-sub ern-hint">
            {t('About')} {dollars}
          </p>
        ) : null}
        <p className="ern-estimate__note">{t('Estimate note')}</p>
      </div>
      <PreviewActionButton product="earn" variant="primary" size={48} fullWidth>
        {t('Subscribe action')}
      </PreviewActionButton>
    </div>
  );
}

function RedeemForm() {
  const { t } = earnCopy.useCopy();
  const [positionId, setPositionId] = useState(sample.positions[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const position = sample.positions.find((p) => p.id === positionId) ?? null;
  if (!position) return <p className="if-preview__note">{t('No positions')}</p>;
  const product = productById.get(position.productId)!;
  const { asset } = product;
  const locked = product.termDays !== null;
  const back = amount === '' ? null : sumDecimals([amount, position.collected]);
  return (
    <div className="ern-form">
      <div className="ern-picks" role="radiogroup" aria-label={t('Redeem choose')}>
        {sample.positions.map((p) => {
          const prod = productById.get(p.productId)!;
          const active = p.id === position.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              className="ern-pick"
              data-active={active || undefined}
              onClick={() => {
                setPositionId(p.id);
                setAmount('');
              }}
            >
              <CoinIcon asset={prod.asset} size={20} />
              <span>
                {prod.asset} · {prod.termDays === null ? t('Flexible') : t('Locked days', { days: prod.termDays })}
              </span>
            </button>
          );
        })}
      </div>
      <AmountInput
        label={t('Redeem amount')}
        unit={asset}
        value={amount}
        onValueChange={setAmount}
        precision={sample.places[asset]}
        maxLabel={t('Max')}
        onMax={() => setAmount(position.principal)}
      />
      <div className="ern-estimate">
        <dl>
          <div>
            <dt>{t('Redeem back')}</dt>
            <dd>{withUnit(asset, back)}</dd>
          </div>
          <div>
            <dt>{t('Redeem timing')}</dt>
            <dd>{locked ? t('Redeem timing locked', { days: position.endsInDays ?? 0 }) : t('Redeem timing flexible')}</dd>
          </div>
        </dl>
        <p className="ern-estimate__note">{t('Redeem back note')}</p>
      </div>
      <PreviewActionButton product="earn" variant="primary" size={48} fullWidth>
        {locked ? t('Redeem action locked') : t('Redeem action')}
      </PreviewActionButton>
    </div>
  );
}
