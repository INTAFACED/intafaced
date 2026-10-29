import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { TokenListRow, TokensLeaderboard } from '@intafaced/contracts/protocol-tokens';
import { navigate } from '../../../app/location';
import { DataTable, EmptyState, Failure, Page, Panel } from '../../../shared/ui';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { ADDRESS_SHAPE } from '../routes';
import { currentPreferences, usePreferences } from '../../../shared/preferences';
import { compareDecimal as compareDecimals } from '../../../data/decimal';
import { clockTime, stamp } from '../../../screens/money/time';
import { protocolCopy } from '../copy';
import { ImportWatchlist } from './ImportWatchlist';
import { TabList } from './TabList';
import { tokensCopy, type TokensTranslate } from './copy';
import { exactUnits, isoTime, percentFromBps, shortAddress } from './format';
import { readWindow, saveWindow, TOKEN_WINDOWS, type TokenWindow } from './storage';
import '../protocol.css';
import './tokens.css';

export type TokensTab = 'trending' | 'top' | 'new' | 'brief' | 'stablecoins' | 'leaderboard' | 'stocks';
const TABS: readonly TokensTab[] = ['trending', 'top', 'new', 'brief', 'stablecoins', 'leaderboard', 'stocks'];
/** The owner-published stablecoin list is blank, so the screener refuses with this code (D-portfolio-wallet-06). */
export const STABLECOINS_UNSET = 'indexer.stablecoins_unset';
/** A tokenized stock is listed only with a recorded licence hash; with none recorded the screener names the `licence` blocker. */
export const STOCKS_BLOCKER = 'licence';

type ListTab = 'trending' | 'top' | 'new';

function useProtocol() {
  const transport = useApi();
  return useMemo(() => createProtocolApi(transport), [transport]);
}

/** Decimal strings compared without a `number` (the app's own decimal helper); an unreadable one sorts as equal. */
export const compareDecimal = (a: string, b: string): number => compareDecimals(a, b) ?? 0;

/**
 * The rows a tab shows, in its order. Trending ranks by growth over the window, so a token with no price (and so no
 * growth) is not ranked there; Top traded ranks by volume over the window; New listings by when the first pool was made.
 * The search narrows any of them by name, symbol or address.
 */
export function rowsFor(tab: ListTab, rows: readonly TokenListRow[], query: string): TokenListRow[] {
  const needle = query.trim().toLowerCase();
  const found = needle
    ? rows.filter((row) => [row.token.name, row.token.symbol, row.token.address].some((field) => field.toLowerCase().includes(needle)))
    : [...rows];
  if (tab === 'trending') return found.filter((row) => row.growthBps !== null).sort((a, b) => b.growthBps! - a.growthBps!);
  if (tab === 'top') return found.sort((a, b) => compareDecimal(b.volume, a.volume));
  return found.sort((a, b) => b.listedAt - a.listedAt);
}

function TokenName({ row, t }: { row: TokenListRow; t: TokensTranslate }) {
  const { token, lookalikeOf } = row;
  return (
    <>
      <a href={`/dex/tokens/${token.address}`}>{lookalikeOf ? shortAddress(token.address) : token.name || t('noName')}</a>{' '}
      {lookalikeOf ? (
        // A copied name or symbol is masked, never hidden: the row stays, and says what it copies.
        <span className="badge" data-testid="token-symbol-masked">
          {t('symbolMasked', { name: lookalikeOf.name })}
        </span>
      ) : (
        <>
          <span className="muted">{token.symbol || t('noSymbol')}</span>{' '}
          <span className="muted tokens-address">{shortAddress(token.address)}</span>
        </>
      )}
    </>
  );
}

function TokenList({
  tab,
  span,
  query,
  onQuery,
  t,
}: {
  tab: ListTab;
  span: TokenWindow;
  query: string;
  onQuery: (value: string) => void;
  t: TokensTranslate;
}) {
  const protocol = useProtocol();
  const { resource, reload } = useResource((signal) => protocol.tokensList(span, signal), `tokens:list:${span}`);
  const windowName = t(`window_${span}`);
  const headers = [
    t('hdrToken'),
    t('hdrPrice'),
    t('rankFor', { column: t('hdrGrowth'), window: windowName }),
    t('rankFor', { column: t('hdrVolume'), window: windowName }),
    t('hdrListed'),
  ];
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    // A pasted contract address opens that token's page, listed or not.
    if (ADDRESS_SHAPE.test(value)) navigate(`/dex/tokens/${value}`);
  }
  let rows: ReactNode;
  let asOf: ReactNode = null;
  if (resource.status === 'loading')
    rows = (
      <tr>
        <td colSpan={headers.length} className="muted">
          {t('reading')}
        </td>
      </tr>
    );
  else if (resource.status === 'failed')
    rows = (
      <tr>
        <td colSpan={headers.length}>
          <Failure result={resource.failure} retry={reload} />
        </td>
      </tr>
    );
  else {
    const { quote, tokens, blockNumber } = resource.data;
    const shown = rowsFor(tab, tokens, query);
    asOf = (
      <p className="muted" data-testid="tokens-as-of" data-block={blockNumber}>
        {t('asOfBlock', { block: blockNumber, time: clockTime(resource.data.asOf * 1000, currentPreferences().timeZone) })}{' '}
        {t('pricesIn', { symbol: quote.symbol })}
      </p>
    );
    rows =
      shown.length === 0 ? (
        <tr>
          <td colSpan={headers.length}>
            <EmptyState title={query.trim() ? t('searchNone') : tab === 'trending' ? t('trendingNone') : t('listNone')} />
          </td>
        </tr>
      ) : (
        shown.map((row) => (
          <tr key={row.token.address} data-token={row.token.address}>
            <th scope="row">
              <TokenName row={row} t={t} />
            </th>
            <td>{row.price === null ? t('noPrice') : `${row.price} ${quote.symbol}`}</td>
            <td>
              {row.growthBps === null ? (
                t('noPrice')
              ) : (
                <span data-testid="token-growth" data-window={span} data-bps={row.growthBps}>
                  {percentFromBps(row.growthBps)}
                </span>
              )}
            </td>
            <td>
              <span data-testid="token-volume" data-window={span}>
                {row.volume}
              </span>{' '}
              {quote.symbol}
            </td>
            <td>
              <time data-testid="token-listed-at" dateTime={isoTime(row.listedAt)}>
                {stamp(isoTime(row.listedAt), currentPreferences().timeZone)}
              </time>
            </td>
          </tr>
        ))
      );
  }
  return (
    <>
      <form role="search" onSubmit={submit}>
        <input
          type="search"
          className="tokens-search"
          aria-label={t('search')}
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </form>
      {asOf}
      <DataTable label={t('tableTokens')} headers={headers}>
        {rows}
      </DataTable>
      {tab === 'trending' && (
        <>
          <p>
            <a href="#how-trending">{t('howTrending')}</a>
          </p>
          <section id="how-trending" aria-label={t('howTrending')} className="tokens-note">
            <h3>{t('howTrending')}</h3>
            <p data-testid="trending-formula">{t('howTrendingBody')}</p>
          </section>
        </>
      )}
    </>
  );
}

type BoardRow = TokensLeaderboard['rows'][number];

function WalletTrades({ row, quote, t }: { row: BoardRow; quote: TokensLeaderboard['quote']; t: TokensTranslate }) {
  const headers = [t('hdrTime'), t('hdrToken'), t('hdrSide'), t('hdrAmount'), t('hdrPaid', { symbol: quote.symbol }), t('hdrRealised')];
  return (
    <section aria-label={t('walletTrades', { wallet: row.wallet })}>
      <h3>{t('walletTrades', { wallet: row.wallet })}</h3>
      <DataTable label={t('tab_trades')} headers={headers}>
        {row.trades.map((trade) => (
          <tr key={`${trade.tx}:${trade.logIndex}`}>
            <td>
              <time dateTime={isoTime(trade.time)}>{stamp(isoTime(trade.time), currentPreferences().timeZone)}</time>
            </td>
            <td>{trade.token.symbol || shortAddress(trade.token.address)}</td>
            <td>{trade.side === 'buy' ? t('sideBuy') : t('sideSell')}</td>
            <td>{exactUnits(trade.amount, trade.token.decimals)}</td>
            <td>{exactUnits(trade.quoteAmount, quote.decimals)}</td>
            <td>{trade.realised === null ? t('notRealised') : <span data-testid="trade-realised">{trade.realised}</span>}</td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}

function Leaderboard({ t }: { t: TokensTranslate }) {
  const protocol = useProtocol();
  const { resource, reload } = useResource((signal) => protocol.tokensLeaderboard(signal), 'tokens:leaderboard');
  const [open, setOpen] = useState<string | null>(null);
  const headers = [t('hdrWallet'), t('hdrRealised'), t('hdrTrades')];
  if (resource.status === 'loading') return <p className="muted">{t('reading')}</p>;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const { rows, quote } = resource.data;
  const chosen = rows.find((row) => row.wallet === open) ?? null;
  return (
    <>
      <p className="muted">{t('leaderboardRule', { symbol: quote.symbol })}</p>
      <DataTable label={t('tableLeaderboard')} headers={headers}>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={headers.length}>
              <EmptyState title={t('leaderboardNone')} />
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.wallet} data-wallet={row.wallet}>
              <th scope="row">
                <a
                  href={`#wallet-${row.wallet}`}
                  title={row.wallet}
                  onClick={(event) => {
                    event.preventDefault();
                    setOpen(row.wallet);
                  }}
                >
                  {shortAddress(row.wallet)}
                </a>
              </th>
              <td>
                <span data-testid="leaderboard-realised">{row.realised}</span> {quote.symbol}
              </td>
              <td>{row.trades.length}</td>
            </tr>
          ))
        )}
      </DataTable>
      {chosen && <WalletTrades row={chosen} quote={quote} t={t} />}
    </>
  );
}

/**
 * The Tokens room (/dex/tokens, D-portfolio-wallet-06 and -07): Trending, Top traded and New listings over the factory's
 * pools, the market brief, the stablecoin and stocks screeners and the wallet leaderboard. Every figure is read from the
 * chain at one block; where a source is missing the tab says which, and no row, rank or price is made up. The window choice
 * is kept in the browser when it can be, and the room works the same when it cannot.
 */
export function TokensRoom() {
  const { language } = usePreferences();
  const { t, renderedLocale } = tokensCopy.forLocale(language);
  const room = protocolCopy.forLocale(language).t;
  const [tab, setTab] = useState<TokensTab>('trending');
  const [span, setSpan] = useState<TokenWindow>(() => readWindow());
  const [query, setQuery] = useState('');
  const listed = tab === 'trending' || tab === 'top' || tab === 'new';
  let body: ReactNode;
  if (listed) body = <TokenList tab={tab} span={span} query={query} onQuery={setQuery} t={t} />;
  else if (tab === 'brief') body = <EmptyState title={t('noBrief')}>{t('noBriefBody')}</EmptyState>;
  else if (tab === 'stablecoins')
    body = (
      <div role="status" data-code={STABLECOINS_UNSET}>
        <EmptyState title={t('stablecoinsUnset')}>{t('stablecoinsCode', { code: STABLECOINS_UNSET })}</EmptyState>
      </div>
    );
  else if (tab === 'leaderboard') body = <Leaderboard t={t} />;
  else
    body = (
      <div role="status" data-code={STOCKS_BLOCKER}>
        <EmptyState title={t('stocksEmpty')}>{t('stocksBlocked')}</EmptyState>
      </div>
    );
  return (
    <div className="legacy-room protocol-room tokens-room" lang={renderedLocale}>
      <Page
        title={t('title')}
        description={t('description')}
        eyebrow={
          <>
            <span>{room('bannerLine')}</span>
            <span className="badge protocol-pill">{room('bannerPill')}</span>
          </>
        }
      >
        <Panel title={t(`tab_${tab}`)}>
          {listed && (
            <label className="tokens-window">
              <span>{t('window')}</span>
              <select
                value={span}
                onChange={(event) => {
                  const next = event.target.value as TokenWindow;
                  setSpan(next);
                  saveWindow(next);
                }}
              >
                {TOKEN_WINDOWS.map((entry) => (
                  <option key={entry} value={entry}>
                    {t(`window_${entry}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <TabList label={t('sections')} tabs={TABS.map((id) => ({ id, label: t(`tab_${id}`) }))} value={tab} onChange={setTab}>
            {body}
          </TabList>
        </Panel>
        <ImportWatchlist t={t} />
      </Page>
    </div>
  );
}

/** The link into the Tokens room from the other DEX sections. */
export function TokensNav() {
  const { language } = usePreferences();
  const { t } = tokensCopy.forLocale(language);
  return (
    <nav aria-label={t('marketsNav')} className="tokens-nav">
      <a href="/dex/tokens">{t('navTokens')}</a>
    </nav>
  );
}
