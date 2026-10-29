import { useState, type ReactNode } from 'react';
import { DataTable, EmptyState, Page, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { protocolCopy } from '../copy';
import { TabList } from './TabList';
import { tokensCopy, type TokensTranslate } from './copy';
import { readWindow, saveWindow, TOKEN_WINDOWS, type TokenWindow } from './storage';
import '../protocol.css';
import './tokens.css';

export type TokensTab = 'trending' | 'top' | 'new' | 'brief' | 'stablecoins' | 'leaderboard' | 'stocks';
const TABS: readonly TokensTab[] = ['trending', 'top', 'new', 'brief', 'stablecoins', 'leaderboard', 'stocks'];
/** The owner-published stablecoin list is blank, so the screener refuses with this code (D-portfolio-wallet-06). */
export const STABLECOINS_UNSET = 'indexer.stablecoins_unset';

function Blocked({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span}>
        <div role="status" data-blocker="indexer">
          <EmptyState title={children} />
        </div>
      </td>
    </tr>
  );
}

/** The ranking column each token list sorts by. With no token list there are no rows to sort. */
const RANK: Record<'trending' | 'top' | 'new', 'hdrGrowth' | 'hdrVolume' | 'hdrListed'> = {
  trending: 'hdrGrowth',
  top: 'hdrVolume',
  new: 'hdrListed',
};

function TokenList({ tab, t }: { tab: 'trending' | 'top' | 'new'; t: TokensTranslate }) {
  const [query, setQuery] = useState('');
  const headers = [t('hdrToken'), t('hdrPrice'), t('hdrLiquidity'), t(RANK[tab])];
  return (
    <>
      <input
        type="search"
        className="tokens-search"
        aria-label={t('search')}
        placeholder={t('searchPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <DataTable label={t('tableTokens')} headers={headers}>
        <Blocked span={headers.length}>{t('listBlocked')}</Blocked>
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
  let body: ReactNode;
  if (tab === 'trending' || tab === 'top' || tab === 'new') body = <TokenList key={tab} tab={tab} t={t} />;
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
        <Blocked span={headers.length}>{t('leaderboardBlocked')}</Blocked>
      </DataTable>
    );
  } else
    body = (
      <div role="status" data-code="licence">
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
        <Panel title={t(`tab_${tab}`)}>
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
