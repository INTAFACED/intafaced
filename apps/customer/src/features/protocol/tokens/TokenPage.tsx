// volt-room: /dex/tokens/:address
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Tag } from '@intafaced/ui/lit';
import { Candles, MonitorTemplate } from '@intafaced/ui/lit/templates';
import type { TokenPageData } from '@intafaced/contracts/protocol-tokens';
import { PRICE_SETTINGS_UNSET } from '@intafaced/contracts/protocol-swap';
import { navigate } from '../../../app/location';
import { DataTable, EmptyState, Failure, Panel } from '../volt/parts';
import { useResource } from '../../../shared/resource';
import { createProtocolApi } from '../api';
import { currentPreferences, usePreferences } from '../../../shared/preferences';
import { clockTime, stamp } from '../../../screens/money/time';
import { protocolCopy } from '../copy';
import { ADDRESS_SHAPE } from '../routes';
import { QuickTicket } from './QuickTicket';
import { InfoUpdate } from './InfoUpdate';
import { TabList } from './TabList';
import { useApi, useSession } from '../../session';
import { useAccountTokenWatchlist, type ListWrite } from '../watch/account-lists';
import { tokensCopy, type TokensTranslate } from './copy';
import { exactUnits, isoTime, percentFromBps, shortAddress } from './format';
import { addToWatchlist, readWatchlist, removeFromWatchlist, type WatchlistWrite } from './storage';

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
    <div className="lt-stack">
      {on ? (
        <Button tone="secondary" aria-pressed="true" title={t('watchRemove')} disabled={busy} onClick={onRemove}>
          {t('watchOn')}
        </Button>
      ) : (
        <Button tone="secondary" disabled={busy} onClick={onAdd}>
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
  if (list === null) return <p className="lt-hint">{t('watchUnavailable')}</p>;
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
        <span className="lt-hint" role={problem ? 'alert' : undefined}>
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
      <div className="lt-stack">
        <Button tone="secondary" disabled>
          {t('watchAdd')}
        </Button>
        <span className="lt-hint">{t('watchAccountChecking')}</span>
      </div>
    );
  if (list.status === 'failed')
    return (
      <div className="lt-stack">
        <span className="lt-hint">{t('watchAccountFailed')}</span>
        <Button tone="secondary" onClick={list.reload}>
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
        <span className="lt-hint" role={problem ? 'alert' : undefined}>
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

/** One candle per minute with a swap, in the other token of the pair, side by side. Every candle carries its own minute. */
function CandleChart({ pair, data, t }: { pair: PageData['pairs'][number]; data: PageData; t: TokensTranslate }) {
  const label = t('priceChartOf', {
    token: data.token.symbol || shortAddress(data.token.address),
    other: pair.other.symbol || t('noSymbol'),
    fee: percentFromBps(pair.feeBps).replace(/^\+/, ''),
  });
  return (
    <Candles
      label={label}
      marks={{ 'data-pool': pair.pool }}
      candles={pair.candles.map((candle) => ({
        key: String(candle.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        marks: { 'data-testid': 'candle', 'data-time': isoTime(candle.time), 'data-period': '60' },
      }))}
      empty={t('chartEmpty')}
      caption={
        pair.candles.length === 0 ? undefined : t('chartCaption', { other: pair.other.symbol || t('noSymbol'), count: pair.candles.length })
      }
    />
  );
}

function SectionBody({ section, data, t }: { section: Section; data: PageData; t: TokensTranslate }) {
  const { token } = data;
  if (section === 'pairs') {
    const headers = [t('hdrPair'), t('hdrFee'), t('hdrLiquidity'), t('hdrVolumeAll', { symbol: token.symbol || t('noSymbol') })];
    return (
      <>
        {data.pairs.length === 0 ? (
          <Candles label={t('priceChart')} candles={[]} empty={t('chartNoPool')} />
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
        <dl className="lt-kv">
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

type ProtocolApi = ReturnType<typeof createProtocolApi>;

/**
 * The token's price in US dollars (D-swap-11): the same `amm.prices` read the swap form uses, from the pools against the
 * owner's dollar reference tokens at one block, shown in full with that block's time. Blank reference settings refuse by
 * their code; a token the reliability filter leaves out says why. Never a guess or a carried-over figure.
 */
function UsdPrice({ address, api, t }: { address: string; api: ProtocolApi; t: TokensTranslate }) {
  const { resource, reload } = useResource((signal) => api.tokenPrices(signal), 'tokens:usd');
  if (resource.status === 'loading') return <span className="lt-hint">{t('usdReading')}</span>;
  if (resource.status === 'failed')
    return resource.failure.code === PRICE_SETTINGS_UNSET ? (
      <span data-blocker="price_feed" data-code={PRICE_SETTINGS_UNSET}>
        {t('notAvailable')}: {t('usdBlocked', { code: PRICE_SETTINGS_UNSET })}
      </span>
    ) : (
      <Failure result={resource.failure} retry={reload} />
    );
  const { prices, asOf, blockNumber } = resource.data;
  const found = prices.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
  if (!found) return <span>{t('usdUnread')}</span>;
  if (found.usd === null) return <span data-reason={found.reason}>{found.reason === 'thin_reserve' ? t('usdThin') : t('usdNoRoute')}</span>;
  return (
    <>
      <span data-testid="token-price-usd" data-usd={found.usd} data-block={blockNumber}>
        ${found.usd}
      </span>{' '}
      ·{' '}
      <time data-testid="token-usd-as-of" dateTime={asOf}>
        {t('usdAsOf', { time: clockTime(Date.parse(asOf), currentPreferences().timeZone), block: blockNumber })}
      </time>
      <br />
      <span className="lt-hint">{t(`usdBasis_${found.basis!}`)}</span>
    </>
  );
}

function TokenFacts({ data, api, t }: { data: PageData; api: ProtocolApi; t: TokensTranslate }) {
  const { quote } = data;
  return (
    <section aria-label={t('factsTitle')}>
      <Panel title={t('factsTitle')}>
        <p className="lt-hint">
          <time data-testid="token-as-of" dateTime={isoTime(data.asOf)}>
            {t('asOfTime', {
              time: clockTime(data.asOf * 1000, currentPreferences().timeZone),
              block: data.blockNumber,
            })}
          </time>
        </p>
        {!data.listed && <p role="status">{t('notListed')}</p>}
        <dl className="lt-kv">
          <Fact
            label={t('factPrice')}
            value={data.price === null ? t('noPrice') : `${data.price} ${quote.symbol || t('noSymbol')}`}
            testId="token-price"
          />
          <Fact label={t('factPriceUsd')} value={<UsdPrice address={data.token.address} api={api} t={t} />} />
          <Fact
            label={t('factLiquidity')}
            value={
              data.pairs.length === 0 ? (
                t('pairsNone')
              ) : (
                <ul className="lt-rows">
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
          <p role="alert" className="lt-refusal">
            {t('impersonating', { name: trust.lookalikeOf.name, symbol: trust.lookalikeOf.symbol, address: trust.lookalikeOf.address })}
          </p>
        )}
        <dl className="lt-kv">
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
        <p className="lt-hint" data-testid="token-trust-note">
          {trust.tier === 'unknown' ? t('tierNote') : t('tierRefusedNote', { code: trust.tierRefusal ?? '' })}
        </p>
        <p className="lt-hint">{t('organicNote', { code: trust.organicRefusal })}</p>
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
  if (resource.status === 'loading') return <p className="lt-hint">{t('reading')}</p>;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const data = resource.data;
  return (
    <>
      <p className="lt-hint lt-wrap">
        {data.token.name || t('noName')} · {data.token.symbol || t('noSymbol')} · {data.token.address}
      </p>
      <TokenFacts data={data} api={protocol} t={t} />
      <QuickTicket data={data} api={protocol} t={t} />
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
 * The open scam reports about this address (D-developer-compliance-01), from the address risk read: a count only, never
 * who reported. It reads on its own, so it shows even where the token's own read refuses. The same read carries the
 * token's standing (D-launch-listing-02): the Blocked badge, and the gating of a permissioned token.
 */
function ScamReports({ address, t }: { address: string; t: TokensTranslate }) {
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const { resource, reload } = useResource((signal) => api.addressRisk(address, signal), `token-scam:${address.toLowerCase()}`);
  return (
    <section aria-label={t('scamTitle')}>
      <Panel title={t('scamTitle')}>
        {resource.status === 'loading' && <p role="status">{t('scamReading')}</p>}
        {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
        {resource.status === 'ready' && (
          <>
            {resource.data.blocked && (
              <p data-testid="token-blocked">
                <Tag>{t('standingBlocked')}</Tag> {t('standingBlockedNote', { reason: resource.data.blocked.reason })}
              </p>
            )}
            {resource.data.permissioned && (
              <p data-testid="token-permissioned">
                <Tag>{t('standingPermissioned')}</Tag>{' '}
                {t('standingPermissionedNote', {
                  checker: resource.data.permissioned.checkerAddress,
                  pool: resource.data.permissioned.pool,
                })}
              </p>
            )}
            <p data-testid="scam-reports">
              {resource.data.openReports === 1 ? t('scamOne') : t('scamMany', { count: String(resource.data.openReports) })}
            </p>
            <p className="lt-hint">{t('scamNote')}</p>
          </>
        )}
      </Panel>
    </section>
  );
}

/**
 * A token's page (/dex/tokens/:address, D-portfolio-wallet-07 with D-launch-listing-02 and D-explorer-05): facts, trust,
 * pairs, holders and trades, all read from the chain at one block, and the dollar price from the pools' own read. A figure
 * with no source (market cap, the trust criteria and the organic score's inputs) names what is missing instead of a guess.
 */
export function TokenPage({ address }: { address: string | undefined }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = tokensCopy.forLocale(language);
  const room = protocolCopy.forLocale(language).t;
  const valid = address !== undefined && ADDRESS_SHAPE.test(address);
  return (
    <div lang={renderedLocale} data-route="tokenDetail">
      <MonitorTemplate
        title={valid ? t('pageTitle', { address }) : t('notFoundTitle')}
        state={{ kind: 'ready' }}
        figures={[]}
        actions={
          valid ? (
            <div className="lt-actions">
              <WatchButton address={address} t={t} />
              <InfoUpdate token={address} t={t} />
            </div>
          ) : undefined
        }
        panels={
          <>
            <p className="lt-hint">
              <span>{t('pageBanner')}</span> <Tag>{room('bannerPill')}</Tag>
            </p>
            {valid ? (
              <>
                <TokenBody address={address} t={t} />
                <ScamReports address={address} t={t} />
              </>
            ) : (
              <Panel title={t('notFoundTitle')}>
                <div data-code="protocol.not_found" role="status">
                  <EmptyState title={t('notFoundBody')} />
                </div>
              </Panel>
            )}
          </>
        }
        related={
          <Button tone="secondary" onClick={() => navigate('/dex/tokens')}>
            {t('back')}
          </Button>
        }
      />
    </div>
  );
}
