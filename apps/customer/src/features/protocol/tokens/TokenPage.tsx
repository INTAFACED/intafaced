import { useMemo, useState, type ReactNode } from 'react';
import type { TokenPageData } from '@intafaced/contracts/protocol-tokens';
import { navigate } from '../../../app/location';
import { Button, DataTable, EmptyState, Failure, Page, Panel } from '../../../shared/ui';
import { useResource } from '../../../shared/resource';
import { createProtocolApi } from '../api';
import { currentPreferences, usePreferences } from '../../../shared/preferences';
import { dec } from '../../../data/decimal';
import { clockTime, stamp } from '../../../screens/money/time';
import { protocolCopy } from '../copy';
import { ADDRESS_SHAPE } from '../routes';
import { TabList } from './TabList';
import { useApi, useSession } from '../../session/session';
import { useAccountTokenWatchlist, type ListWrite } from '../watch/account-lists';
import { tokensCopy, type TokensTranslate } from './copy';
import { exactUnits, isoTime, percentFromBps, shortAddress } from './format';
import { addToWatchlist, readWatchlist, removeFromWatchlist, type WatchlistWrite } from './storage';
import '../protocol.css';
import './tokens.css';

type Section = 'pairs' | 'holders' | 'trades';
const SECTIONS: readonly Section[] = ['pairs', 'holders', 'trades'];

function Fact({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd {...(testId ? { 'data-testid': testId } : {})}>{value}</dd>
    </div>
  );
}

function WatchToggle({
  on,
  busy = false,
  note,
  onAdd,
  onRemove,
  t,
}: {
  on: boolean;
  busy?: boolean;
  note: ReactNode;
  onAdd: () => void;
  onRemove: () => void;
  t: TokensTranslate;
}) {
  return (
    <div className="tokens-watch">
      {on ? (
        <Button variant="secondary" aria-pressed="true" title={t('watchRemove')} disabled={busy} onClick={onRemove}>
          {t('watchOn')}
        </Button>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={onAdd}>
          {t('watchAdd')}
        </Button>
      )}
      {note}
    </div>
  );
}

/** Signed out, the watchlist is kept in this browser. */
function BrowserWatch({ address, t }: { address: string; t: TokensTranslate }) {
  const [list, setList] = useState<string[] | null>(() => readWatchlist());
  const [problem, setProblem] = useState<'not_saved' | 'full' | null>(null);
  if (list === null) return <p className="muted">{t('watchUnavailable')}</p>;
  const change = (write: WatchlistWrite) => {
    if (write.ok) setList(write.list);
    else if (write.reason === 'blocked') setList(null);
    setProblem(!write.ok && write.reason !== 'blocked' ? write.reason : null);
  };
  return (
    <WatchToggle
      on={list.includes(address.toLowerCase())}
      onAdd={() => change(addToWatchlist(address))}
      onRemove={() => change(removeFromWatchlist(address))}
      note={
        <span className="muted" role={problem ? 'alert' : undefined}>
          {problem === 'full' ? t('watchFull') : problem ? t('watchNotSaved') : t('watchNote')}
        </span>
      }
      t={t}
    />
  );
}

const ACCOUNT_PROBLEM: Record<Exclude<ListWrite, 'saved'>, 'watchAccountNotSaved' | 'watchFull' | 'watchUnknown'> = {
  'not-saved': 'watchAccountNotSaved',
  full: 'watchFull',
  unknown: 'watchUnknown',
};

/** Signed in, the watchlist is the account's own (`protocol.token-watchlist`), so it follows the person to every device. */
function AccountWatch({ address, t }: { address: string; t: TokensTranslate }) {
  const { list, change } = useAccountTokenWatchlist();
  const [outcome, setOutcome] = useState<ListWrite | 'saving' | null>(null);
  if (list.status === 'signed-out') return null;
  if (list.status === 'loading')
    return (
      <div className="tokens-watch">
        <Button variant="secondary" disabled>
          {t('watchAdd')}
        </Button>
        <span className="muted">{t('watchAccountChecking')}</span>
      </div>
    );
  if (list.status === 'failed')
    return (
      <div className="tokens-watch">
        <span className="muted">{t('watchAccountFailed')}</span>
        <Button variant="secondary" onClick={list.reload}>
          {t('tryAgain')}
        </Button>
      </div>
    );
  const key = address.toLowerCase();
  const write = async (apply: (items: string[]) => string[]) => {
    setOutcome('saving');
    setOutcome(await change(apply));
  };
  const problem = outcome && outcome !== 'saving' && outcome !== 'saved' ? ACCOUNT_PROBLEM[outcome] : null;
  return (
    <WatchToggle
      on={list.items.includes(key)}
      busy={outcome === 'saving'}
      onAdd={() => void write((items) => (items.includes(key) ? items : [...items, key]))}
      onRemove={() => void write((items) => items.filter((entry) => entry !== key))}
      note={
        <span className="muted" role={problem ? 'alert' : undefined}>
          {problem ? t(problem) : t('watchNoteAccount')}
        </span>
      }
      t={t}
    />
  );
}

function WatchButton({ address, t }: { address: string; t: TokensTranslate }) {
  const { userId } = useSession();
  return userId ? <AccountWatch address={address} t={t} /> : <BrowserWatch address={address} t={t} />;
}

type PageData = TokenPageData;

/** A decimal string as a bigint scaled by 1e18, for drawing only: chart geometry never goes through a `number` price. */
const scaled = (value: string): bigint => dec(value) ?? 0n;

const CHART_WIDTH = 600;
const CHART_HEIGHT = 200;

/** One SVG candle per minute with a swap, in the other token of the pair. Every candle carries its own minute. */
function CandleChart({ pair, data, t }: { pair: PageData['pairs'][number]; data: PageData; t: TokensTranslate }) {
  const label = t('priceChartOf', {
    token: data.token.symbol || shortAddress(data.token.address),
    other: pair.other.symbol || t('noSymbol'),
    fee: percentFromBps(pair.feeBps).replace(/^\+/, ''),
  });
  if (pair.candles.length === 0)
    return (
      <figure role="img" aria-label={label} className="tokens-chart" data-pool={pair.pool}>
        <figcaption>{t('chartEmpty')}</figcaption>
      </figure>
    );
  const highs = pair.candles.map((c) => scaled(c.high));
  const lows = pair.candles.map((c) => scaled(c.low));
  const top = highs.reduce((a, b) => (b > a ? b : a));
  const bottom = lows.reduce((a, b) => (b < a ? b : a));
  const range = top - bottom === 0n ? 1n : top - bottom;
  const y = (price: string) => Number(((top - scaled(price)) * BigInt(CHART_HEIGHT - 20)) / range) + 10;
  const step = CHART_WIDTH / pair.candles.length;
  return (
    <figure role="img" aria-label={label} className="tokens-chart" data-pool={pair.pool}>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="tokens-candles" aria-hidden="true">
        {pair.candles.map((candle, i) => {
          const up = scaled(candle.close) >= scaled(candle.open);
          const x = i * step + step / 2;
          const bodyTop = Math.min(y(candle.open), y(candle.close));
          const bodyHeight = Math.max(Math.abs(y(candle.open) - y(candle.close)), 1);
          return (
            <g key={candle.time} data-testid="candle" data-time={isoTime(candle.time)} data-period="60" className={up ? 'up' : 'down'}>
              <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} />
              <rect x={x - step / 4} width={step / 2} y={bodyTop} height={bodyHeight} />
            </g>
          );
        })}
      </svg>
      <figcaption className="muted">
        {t('chartCaption', { other: pair.other.symbol || t('noSymbol'), count: pair.candles.length })}
      </figcaption>
    </figure>
  );
}

function SectionBody({ section, data, t }: { section: Section; data: PageData; t: TokensTranslate }) {
  const { token } = data;
  if (section === 'pairs') {
    const headers = [t('hdrPair'), t('hdrFee'), t('hdrLiquidity'), t('hdrVolumeAll', { symbol: token.symbol || t('noSymbol') })];
    return (
      <>
        {data.pairs.length === 0 ? (
          <figure role="img" aria-label={t('priceChart')} className="tokens-chart">
            <figcaption>{t('chartNoPool')}</figcaption>
          </figure>
        ) : (
          data.pairs.map((pair) => <CandleChart key={pair.pool} pair={pair} data={data} t={t} />)
        )}
        <DataTable label={t('tab_pairs')} headers={headers}>
          {data.pairs.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>
                <EmptyState title={t('pairsNone')} />
              </td>
            </tr>
          ) : (
            data.pairs.map((pair) => (
              <tr key={pair.pool} data-pool={pair.pool}>
                <th scope="row">
                  {token.symbol || t('noSymbol')} / {pair.other.symbol || t('noSymbol')}
                </th>
                <td>{percentFromBps(pair.feeBps).replace(/^\+/, '')}</td>
                <td>
                  {exactUnits(pair.reserve, token.decimals)} {token.symbol || t('noSymbol')} ·{' '}
                  {exactUnits(pair.reserveOther, pair.other.decimals)} {pair.other.symbol || t('noSymbol')}
                </td>
                <td>
                  <span data-testid="pair-volume" data-units={pair.volume}>
                    {exactUnits(pair.volume, token.decimals)}
                  </span>
                </td>
              </tr>
            ))
          )}
        </DataTable>
      </>
    );
  }
  if (section === 'holders') {
    const { holders } = data;
    const headers = [t('hdrHolder'), t('hdrAmount')];
    return (
      <>
        <p>{t('holdersRule')}</p>
        <dl className="protocol-facts">
          <Fact
            label={t('totalSupply')}
            value={
              <span data-testid="total-supply" data-units={holders.totalSupply}>
                {exactUnits(holders.totalSupply, token.decimals)}
              </span>
            }
          />
          <Fact
            label={t('burned')}
            value={
              <span data-testid="burned" data-units={holders.burned}>
                {exactUnits(holders.burned, token.decimals)}
              </span>
            }
          />
          <Fact
            label={t('supplyLessBurned')}
            value={
              <span data-testid="supply-less-burned" data-units={holders.supplyLessBurned}>
                {exactUnits(holders.supplyLessBurned, token.decimals)}
              </span>
            }
          />
        </dl>
        <DataTable label={t('tab_holders')} headers={headers}>
          {holders.list.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>
                <EmptyState title={t('holdersNone')} />
              </td>
            </tr>
          ) : (
            holders.list.map((holder) => (
              <tr key={holder.address}>
                <th scope="row" title={holder.address}>
                  {shortAddress(holder.address)}
                </th>
                <td>
                  <span data-testid="holder-amount" data-units={holder.amount}>
                    {exactUnits(holder.amount, token.decimals)}
                  </span>
                </td>
              </tr>
            ))
          )}
        </DataTable>
      </>
    );
  }
  const headers = [t('hdrTime'), t('hdrSide'), t('hdrAmount'), t('hdrOther'), t('hdrWallet')];
  return (
    <DataTable label={t('tab_trades')} headers={headers}>
      {data.trades.length === 0 ? (
        <tr>
          <td colSpan={headers.length}>
            <EmptyState title={t('tradesNone')} />
          </td>
        </tr>
      ) : (
        data.trades.map((trade) => (
          <tr key={`${trade.tx}:${trade.logIndex}`} data-tx={trade.tx}>
            <td>
              <time dateTime={isoTime(trade.time)}>{stamp(isoTime(trade.time), currentPreferences().timeZone)}</time>
            </td>
            <td>{trade.side === 'buy' ? t('sideBuy') : t('sideSell')}</td>
            <td>
              <span data-testid="trade-amount" data-units={trade.amount}>
                {exactUnits(trade.amount, token.decimals)}
              </span>
            </td>
            <td>
              {exactUnits(trade.amountOther, trade.other.decimals)} {trade.other.symbol || t('noSymbol')}
            </td>
            <td title={trade.wallet}>{shortAddress(trade.wallet)}</td>
          </tr>
        ))
      )}
    </DataTable>
  );
}

const FLAG_KEY = {
  no_lp_lock: 'flagNoLpLock',
  no_vesting: 'flagNoVesting',
  lookalike: 'flagLookalike',
  no_history: 'flagNoHistory',
} as const;

function TokenFacts({ data, t }: { data: PageData; t: TokensTranslate }) {
  const { quote } = data;
  return (
    <section aria-label={t('factsTitle')}>
      <Panel title={t('factsTitle')}>
        <p className="muted">
          <time data-testid="token-as-of" dateTime={isoTime(data.asOf)}>
            {t('asOfTime', {
              time: clockTime(data.asOf * 1000, currentPreferences().timeZone),
              block: data.blockNumber,
            })}
          </time>
        </p>
        {!data.listed && <p role="status">{t('notListed')}</p>}
        <dl className="protocol-facts">
          <Fact
            label={t('factPrice')}
            value={data.price === null ? t('noPrice') : `${data.price} ${quote.symbol || t('noSymbol')}`}
            testId="token-price"
          />
          <Fact
            label={t('factPriceUsd')}
            value={
              <span data-blocker="price_feed">
                {t('notAvailable')}: {t('usdBlocked')}
              </span>
            }
          />
          <Fact
            label={t('factLiquidity')}
            value={
              data.pairs.length === 0 ? (
                t('pairsNone')
              ) : (
                <ul className="tokens-plain">
                  {data.pairs.map((pair) => (
                    <li key={pair.pool} data-testid="token-liquidity">
                      {exactUnits(pair.reserve, data.token.decimals)} {data.token.symbol || t('noSymbol')} ·{' '}
                      {exactUnits(pair.reserveOther, pair.other.decimals)} {pair.other.symbol || t('noSymbol')}
                    </li>
                  ))}
                </ul>
              )
            }
          />
          <Fact label={t('factFees')} value={`${data.feesPaid} ${quote.symbol || t('noSymbol')}`} testId="token-fees" />
          <Fact
            label={t('factGrowth24h')}
            value={data.growthBps24h === null ? t('noPrice') : percentFromBps(data.growthBps24h)}
            testId="token-growth-24h"
          />
          <Fact
            label={t('factMarketCap')}
            value={
              <span data-blocker="supply_source">
                {t('notAvailable')}: {t('marketCapNote')}
              </span>
            }
          />
        </dl>
      </Panel>
    </section>
  );
}

function TokenTrust({ data, t }: { data: PageData; t: TokensTranslate }) {
  const { trust } = data;
  return (
    <section aria-label={t('trustTitle')}>
      <Panel title={t('trustTitle')}>
        {trust.lookalikeOf && (
          <p role="alert" className="tokens-alert">
            {t('impersonating', { name: trust.lookalikeOf.name, symbol: trust.lookalikeOf.symbol, address: trust.lookalikeOf.address })}
          </p>
        )}
        <dl className="protocol-facts">
          <Fact
            label={t('trustTier')}
            value={trust.tier === 'unknown' ? t('tierUnknown') : <span data-code={trust.tierRefusal}>{t('tierRefused')}</span>}
            testId="token-trust-tier"
          />
          <Fact
            label={t('organicScore')}
            value={<span data-code={trust.organicRefusal}>{t('notScored')}</span>}
            testId="token-organic-score"
          />
        </dl>
        <p className="muted" data-testid="token-trust-note">
          {trust.tier === 'unknown' ? t('tierNote') : t('tierRefusedNote', { code: trust.tierRefusal ?? '' })}
        </p>
        <p className="muted">{t('organicNote', { code: trust.organicRefusal })}</p>
        <h3 id="token-flags">{t('flags')}</h3>
        <ul aria-labelledby="token-flags">
          {trust.flags.map((flag) => (
            <li key={flag} data-flag={flag}>
              {t(FLAG_KEY[flag])}
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

function TokenBody({ address, t }: { address: string; t: TokensTranslate }) {
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource, reload } = useResource((signal) => protocol.tokenPage(address, signal), `tokens:page:${address.toLowerCase()}`);
  const [section, setSection] = useState<Section>('pairs');
  if (resource.status === 'loading') return <p className="muted">{t('reading')}</p>;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const data = resource.data;
  return (
    <>
      <p className="muted">
        {data.token.name || t('noName')} · {data.token.symbol || t('noSymbol')} · {data.token.address}
      </p>
      <TokenFacts data={data} t={t} />
      <TokenTrust data={data} t={t} />
      <Panel title={t('tokenSections')}>
        <TabList
          label={t('tokenSections')}
          tabs={SECTIONS.map((id) => ({ id, label: t(`tab_${id}`) }))}
          value={section}
          onChange={setSection}
        >
          <SectionBody section={section} data={data} t={t} />
        </TabList>
      </Panel>
    </>
  );
}

/**
 * A token's page (/dex/tokens/:address, D-portfolio-wallet-07 with D-launch-listing-02 and D-explorer-05): facts, trust,
 * pairs, holders and trades, all read from the chain at one block. A figure with no source (the dollar price, market cap,
 * the trust criteria and the organic score's inputs) names what is missing instead of a guess.
 */
export function TokenPage({ address }: { address: string | undefined }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = tokensCopy.forLocale(language);
  const room = protocolCopy.forLocale(language).t;
  const valid = address !== undefined && ADDRESS_SHAPE.test(address);
  return (
    <div className="legacy-room protocol-room tokens-room" lang={renderedLocale} data-route="tokenDetail">
      <Page
        title={valid ? t('pageTitle', { address }) : t('notFoundTitle')}
        eyebrow={
          <>
            <span>{room('bannerLine')}</span>
            <span className="badge protocol-pill">{room('bannerPill')}</span>
          </>
        }
        actions={valid ? <WatchButton address={address} t={t} /> : undefined}
      >
        {valid ? (
          <TokenBody address={address} t={t} />
        ) : (
          <Panel title={t('notFoundTitle')}>
            <div data-code="protocol.not_found" role="status">
              <EmptyState title={t('notFoundBody')} />
            </div>
          </Panel>
        )}
        <Button variant="secondary" onClick={() => navigate('/dex/tokens')}>
          {t('back')}
        </Button>
      </Page>
    </div>
  );
}
