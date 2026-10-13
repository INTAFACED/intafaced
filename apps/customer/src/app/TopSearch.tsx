import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { z } from 'zod';
import { marketSchema, type Market } from '@intafaced/exchange-contract/schemas';
import { useResource, type Resource } from '../shared/resource';
import { useSession } from '../features/session/session';
import { navigate } from './location';
import { roomTitle, roomDescription, searchRooms, normalizePair } from './navigation';
import { ShellIcon } from './icons';
import { shellCopy } from './shell-copy';
import { usePreferences } from '../shared/preferences';

type Group = 'Coins' | 'Markets' | 'Pages';
interface Row {
  key: string;
  group: Group;
  label: string;
  hint: string;
  href: string;
}
const perGroup = 8;
const marketList = z.array(marketSchema);

const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

/**
 * Header search (UI-SPEC 3.1): coins, markets and pages. Enter on a coin opens its page;
 * Enter on a market opens the desk in Pro and the coin page in Simple.
 * TODO(B1): swap to the Base UI Autocomplete in @intafaced/ui.
 * TODO(B3): swap the market lookup to useMarkets() once apps/customer/src/data lands.
 */
export function TopSearch({ compact }: { compact?: boolean }) {
  const { t, requestedLocale } = shellCopy.useCopy();
  const { layoutMode } = usePreferences();
  const { mode } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef<((event: KeyboardEvent) => void) | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setUsed(true);
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) setOpen(false);
    };
    const departed = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('popstate', departed);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('popstate', departed);
    };
  }, [open]);

  const pages = useMemo(
    () =>
      searchRooms(query, mode, requestedLocale)
        .slice(0, perGroup)
        .map<Row>((room) => ({
          key: `page:${room.path}`,
          group: 'Pages',
          label: roomTitle(room, requestedLocale),
          hint: roomDescription(room, requestedLocale),
          href: room.path,
        })),
    [query, mode, requestedLocale],
  );

  return (
    <div className={`tb-search ${compact ? 'tb-search--compact' : ''}`} ref={boxRef}>
      <ShellIcon name="search" size={16} />
      <input
        ref={inputRef}
        type="text"
        name="global-search"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-label={t('Search markets')}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('Search markets')}
        value={query}
        onFocus={() => {
          setUsed(true);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setUsed(true);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            event.currentTarget.blur();
          } else if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) setOpen(true);
          else keysRef.current?.(event);
        }}
      />
      <kbd aria-hidden="true">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      {used && (
        <SearchData
          open={open}
          id={listId}
          query={query}
          pages={pages}
          layoutMode={layoutMode}
          active={active}
          setActive={setActive}
          inputRef={inputRef}
          keysRef={keysRef}
          close={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Loads the listed markets once, after the first use, and keeps them for the session. */
function SearchData({ open, ...props }: PanelProps & { open: boolean }) {
  const { api, userId } = useSession();
  const { resource } = useResource(
    (signal) => api.rest('/markets', marketList, { query: { limit: 500 }, signal }),
    `shell-markets:${userId ?? 'public'}`,
  );
  return open ? <SearchPanel {...props} resource={resource} /> : null;
}

interface PanelProps {
  id: string;
  query: string;
  pages: Row[];
  layoutMode: 'simple' | 'pro';
  active: number;
  setActive: (index: number) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  keysRef: RefObject<((event: KeyboardEvent) => void) | null>;
  close: () => void;
}

function SearchPanel({
  id,
  query,
  pages,
  layoutMode,
  active,
  setActive,
  inputRef,
  keysRef,
  close,
  resource,
}: PanelProps & { resource: Resource<Market[]> }) {
  const { t } = shellCopy.useCopy();
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const rows = useMemo(() => {
    if (resource.status !== 'ready') return pages;
    const listed = resource.data.filter((market) => market.spot && market.active && !market.paper);
    const fits = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const coins = [...new Set(listed.map((market) => market.base))]
      .filter((asset) => fits(asset))
      .slice(0, perGroup)
      .map<Row>((asset) => ({ key: `coin:${asset}`, group: 'Coins', label: asset, hint: '', href: `/coin/${encodeURIComponent(asset)}` }));
    const markets = listed
      .filter((market) => fits(`${market.symbol} ${market.base} ${market.quote}`))
      .slice(0, perGroup)
      .map<Row>((market) => ({
        key: `market:${market.symbol}`,
        group: 'Markets',
        label: market.symbol,
        hint: '',
        href: layoutMode === 'pro' ? `/trade/spot/${normalizePair(market.symbol)}` : `/coin/${encodeURIComponent(market.base)}`,
      }));
    return [...coins, ...markets, ...pages];
  }, [resource, pages, layoutMode, query]);

  function choose(row: Row | undefined) {
    if (!row) return;
    close();
    inputRef.current?.blur();
    navigate(row.href);
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(rows.length ? (active + 1) % rows.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(rows.length ? (active - 1 + rows.length) % rows.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[Math.min(active, rows.length - 1)]);
    }
  }
  // The input owns focus, so it forwards arrow keys and Enter to the open panel.
  useEffect(() => {
    keysRef.current = onKeyDown;
    return () => {
      keysRef.current = null;
    };
  });

  const groups: Group[] = ['Coins', 'Markets', 'Pages'];
  const loading = resource.status === 'loading';
  let index = -1;
  return (
    <div className="tb-popover tb-search-panel" role="presentation">
      <ul id={id} role="listbox" aria-label={t('Search results')}>
        {groups.map((group) => {
          const inGroup = rows.filter((row) => row.group === group);
          if (!inGroup.length) return null;
          return (
            <li key={group} role="presentation">
              <div className="tb-group-title" role="presentation">
                {t(group)}
              </div>
              <ul role="presentation">
                {inGroup.map((row) => {
                  index += 1;
                  const position = index;
                  return (
                    <li
                      key={row.key}
                      id={`${id}-${position}`}
                      role="option"
                      aria-selected={position === active}
                      className="tb-option"
                      onMouseEnter={() => setActive(position)}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => choose(row)}
                    >
                      <span>{row.label}</span>
                      {row.hint && <small>{row.hint}</small>}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      {!rows.length && !loading && (
        <p className="tb-empty" role="status">
          {t('No results for "{query}"', { query })}
        </p>
      )}
      {loading && !rows.length && (
        <p className="tb-empty" role="status">
          {t('Finding markets')}
        </p>
      )}
    </div>
  );
}
