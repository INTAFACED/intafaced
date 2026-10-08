import { useEffect, useState, type ReactNode } from 'react';
import { Button, Dialog, Field, Icon, EmptyState, Failure, Loading } from '../shared/ui';
import { z } from 'zod';
import { marketSchema } from '@intafaced/exchange-contract/schemas';
import { useResource } from '../shared/resource';
import { doors, searchRooms, type Door } from './navigation';
import { useSession } from '../features/session/session';

export function Shell({ door, children }: { door?: Door; children: ReactNode }) {
  const { session, mode, logout } = useSession();
  const [overlay, setOverlay] = useState<'search' | 'person' | 'account' | null>(null);
  const [query, setQuery] = useState('');
  const [logoutNote, setLogoutNote] = useState('');
  const trade = door === 'Trade';
  const explicitPaper = new URLSearchParams(location.search).get('simulated') === 'true';
  const doorHref = (item: (typeof doors)[number]) => (item.name === 'Trade' && explicitPaper ? `${item.path}?simulated=true` : item.path);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay('search');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    const handler = () => setOverlay(null);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  const list = searchRooms(query, mode).slice(0, 15);
  const brand = (
    <a className="brand" href="/money">
      intafaced<span aria-hidden="true">·</span>
    </a>
  );
  return (
    <div className={`app-shell ${trade ? 'trade-shell' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="rail">
        {brand}
        <nav className="door-nav" aria-label="Customer doors">
          {doors.map((item) => (
            <a key={item.name} href={doorHref(item)} aria-current={door === item.name ? 'page' : undefined}>
              <Icon name={item.icon} />
              {item.name}
            </a>
          ))}
        </nav>
        <div className="rail-footer">
          One account.
          <br />
          Your next move.
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          {trade ? (
            <div className="trade-top-nav">
              {brand}
              <nav aria-label="Customer doors">
                {doors.map((item) => (
                  <a key={item.name} href={doorHref(item)} aria-current={door === item.name ? 'page' : undefined}>
                    {item.name}
                  </a>
                ))}
              </nav>
            </div>
          ) : (
            <span className="mobile-brand">{brand}</span>
          )}
          <button
            type="button"
            className="search-trigger"
            onClick={() => {
              setQuery('');
              setOverlay('search');
            }}
            aria-label="Search Intafaced"
          >
            <Icon name="search" size={16} />
            <span>Search markets, rooms and actions</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="account-controls">
            <Button variant="ghost" onClick={() => setOverlay('account')} aria-label="Select account">
              {mode}
              <Icon name="chevron" size={14} />
            </Button>
            <a className="button button--ghost" href="/notifications" aria-label="Account inbox">
              <Icon name="bell" size={18} />
            </a>
            <button type="button" className="person-trigger" aria-label="Open person menu" onClick={() => setOverlay('person')}>
              <Icon name="person" size={17} />
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {logoutNote && (
            <p className="notice" role="status">
              {logoutNote}
            </p>
          )}
          {children}
        </main>
      </div>
      <nav className="mobile-doors" aria-label="Customer doors on phone">
        {doors.map((item) => (
          <a key={item.name} href={doorHref(item)} aria-current={door === item.name ? 'page' : undefined}>
            <Icon name={item.icon} />
            {item.name}
          </a>
        ))}
      </nav>
      {overlay === 'search' && (
        <Dialog title="Search Intafaced" onClose={() => setOverlay(null)}>
          <Field
            label="Find a room or action"
            name="global-search"
            autoFocus
            placeholder="Market, transfers, support…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="search-results">
            {list.length ? (
              list.map((item) => (
                <a key={item.path} href={item.path}>
                  <span>{item.title}</span>
                  <small>
                    {item.door ?? 'Account'} · {item.description}
                  </small>
                </a>
              ))
            ) : (
              <EmptyState title="No matching rooms">Try a market, action or room name.</EmptyState>
            )}
          </div>
          <MarketSearch query={query} />
        </Dialog>
      )}
      {overlay === 'person' && (
        <Dialog title="Your account" onClose={() => setOverlay(null)}>
          <div className="stack">
            {session ? (
              <>
                <p className="muted">
                  Account ID <span className="numeric">{session.userId}</span>
                </p>
                <nav className="search-results" aria-label="Person settings">
                  {[
                    ['/uc/account', 'Account'],
                    ['/uc/safe', 'Security'],
                    ['/verification', 'Verification'],
                    ['/view', 'View and language'],
                    ['/uc/promotion', 'Promotions'],
                    ['/uc/paydividends', 'Dividend records'],
                  ].map(([href, title]) => (
                    <a key={href} href={href}>
                      {title}
                    </a>
                  ))}
                </nav>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void logout().then((result) => {
                      setOverlay(null);
                      setLogoutNote(
                        result.ok
                          ? 'Signed out.'
                          : 'Signed out on this device. The server could not confirm session revocation; use Sign out everywhere after reconnecting.',
                      );
                    })
                  }
                >
                  Sign out
                </Button>
              </>
            ) : (
              <>
                <p className="muted">Sign in to access account, security and verification.</p>
                <a className="button button--primary" href="/login">
                  Sign in
                </a>
              </>
            )}
          </div>
        </Dialog>
      )}
      {overlay === 'account' && (
        <Dialog title="Select account" onClose={() => setOverlay(null)}>
          <div className="stack">
            <div className="link-row">
              <div>
                <strong>Personal</strong>
                <small>{session ? 'Your current account' : 'Default account'}</small>
              </div>
              <span className="positive">Selected</span>
            </div>
            <div>
              <h3>Business</h3>
              <p className="muted">
                A verified company account is not available through the current account contract. Merchant records and strategy subaccounts
                do not establish Business ownership.
              </p>
              <a className="text-link" href="/identbusiness">
                Business verification ↗
              </a>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function MarketSearch({ query }: { query: string }) {
  const { api, userId } = useSession();
  const { resource, reload } = useResource(
    (signal) => api.rest('/markets', z.array(marketSchema), { query: { limit: 500 }, signal }),
    `global-markets:${userId ?? 'public'}`,
  );
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const rows =
    resource.status === 'ready'
      ? resource.data
          .filter(
            (market) =>
              market.spot && words.every((word) => `${market.symbol} ${market.base} ${market.quote}`.toLowerCase().includes(word)),
          )
          .slice(0, 12)
      : [];
  return (
    <section className="section" aria-label="Published markets">
      <h3>Spot markets</h3>
      <p className="muted">Search the first 500 published markets.</p>
      {resource.status === 'loading' ? (
        <Loading label="Finding published markets" />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : rows.length ? (
        <div className="search-results">
          {rows.map((market) => (
            <a key={market.id} href={`/exchange/${encodeURIComponent(market.symbol)}${market.paper ? '?simulated=true' : ''}`}>
              <span>{market.symbol}</span>
              <small>
                {market.paper ? 'Simulation · no live funds' : 'Spot'}
                {market.sessionOpen ? '' : ' · session closed'}
              </small>
            </a>
          ))}
        </div>
      ) : (
        <p className="muted">No published markets match this search.</p>
      )}
      {rows.length === 12 && <p className="muted">First 12 matches. Refine your search or open the market selector.</p>}
    </section>
  );
}
