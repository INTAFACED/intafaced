import { useState, type FormEvent, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { DataTable, EmptyState, Page, Panel } from '../../../shared/ui';
import { ADDRESS_SHAPE } from '../routes';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy } from '../copy';
import { BlockedRow } from './BlockedRow';
import { TabList } from './TabList';
import { tokensCopy, type TokensTranslate } from './copy';
import { readWindow, saveWindow, TOKEN_WINDOWS, type TokenWindow } from './storage';
import '../protocol.css';
import './tokens.css';

export type TokensTab = 'trending' | 'top' | 'new' | 'brief' | 'stablecoins' | 'leaderboard' | 'stocks';
const TABS: readonly TokensTab[] = ['trending', 'top', 'new', 'brief', 'stablecoins', 'leaderboard', 'stocks'];
/** The owner-published stablecoin list is blank, so the screener refuses with this code (D-portfolio-wallet-06). */
export const STABLECOINS_UNSET = 'indexer.stablecoins_unset';
/** A tokenized stock is listed only with a recorded licence hash; with none recorded the screener names the `licence` blocker. */
export const STOCKS_BLOCKER = 'licence';

/** The ranking column each token list sorts by. With no token list there are no rows to sort. */
const RANK: Record<'trending' | 'top' | 'new', 'hdrGrowth' | 'hdrVolume' | 'hdrListed'> = {
  trending: 'hdrGrowth',
  top: 'hdrVolume',
  new: 'hdrListed',
};

function TokenList({
  tab,
  span,
  query,
  onQuery,
  t,
}: {
  tab: 'trending' | 'top' | 'new';
  span: TokenWindow;
  query: string;
  onQuery: (value: string) => void;
  t: TokensTranslate;
}) {
  const [asked, setAsked] = useState(false);
  const rank = tab === 'new' ? t('hdrListed') : t('rankFor', { column: t(RANK[tab]), window: t(`window_${span}`) });
  const headers = [t('hdrToken'), t('hdrPrice'), t('hdrLiquidity'), rank];
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    // A pasted contract address opens that token's page; anything else would need the token list to search.
    if (ADDRESS_SHAPE.test(value)) navigate(`/dex/tokens/${value}`);
    else setAsked(value.length > 0);
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
          onChange={(event) => {
            onQuery(event.target.value);
            setAsked(false);
          }}
        />
      </form>
      {asked && (
        <p className="muted" role="status">
          {t('searchBlocked')}
        </p>
      )}
      <DataTable label={t('tableTokens')} headers={headers}>
        <BlockedRow span={headers.length}>{t('listBlocked')}</BlockedRow>
      </DataTable>
      {tab === 'trending' && (
        <>
          <p>
            <a href="#how-trending">{t('howTrending')}</a>
          </p>
          <section id="how-trending" aria-label={t('howTrending')} className="tokens-note">
            <h3>{t('howTrending')}</h3>
            <p>{t('howTrendingBody')}</p>
          </section>
        </>
      )}
    </>
  );
}

/**
 * The Tokens room (/dex/tokens, D-portfolio-wallet-06 and -07): Trending, Top traded and New listings over the token list,
 * the market brief, the stablecoin and stocks screeners and the wallet leaderboard. Every tab keeps its layout; where a
 * source is missing it says which, and no row, rank or price is made up. The window choice is kept in the browser when it
 * can be, and the room works the same when it cannot.
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
  else if (tab === 'leaderboard') {
    const headers = [t('hdrWallet'), t('hdrRealised'), t('hdrTrades')];
    body = (
      <DataTable label={t('tableLeaderboard')} headers={headers}>
        <BlockedRow span={headers.length}>{t('leaderboardBlocked')}</BlockedRow>
      </DataTable>
    );
  } else
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
