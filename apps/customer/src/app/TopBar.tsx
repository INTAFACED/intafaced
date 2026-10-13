import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { ChevronDown } from 'lucide-react';
import { SegmentedControl, Tooltip, TooltipContent, TooltipTrigger, Wordmark } from '@intafaced/ui';
import { useSession } from '../features/session/session';
import { usePreferences, savePreferences } from '../shared/preferences';
import { proCopy } from '../screens/home/pro-copy';
import { currentReturnLocation } from './location';
import { doorLabel, safeReturnTo, type Door } from './navigation';
import { isFeatureLive } from './feature-registry';
import { ShellIcon } from './icons';
import { accountMenu, tabSpecs, type TabSpec } from './menus';
import { shellCopy } from './shell-copy';
import { TopSearch } from './TopSearch';

/** Sets `--if-banner-offset` to the local stack's banner height (28 px), or 0 when there is no banner. */
export function useBannerOffset() {
  useEffect(() => {
    const apply = () => {
      const banner = document.getElementById('local-test-stack-banner');
      document.documentElement.style.setProperty(
        '--if-banner-offset',
        banner ? `${Math.round(banner.getBoundingClientRect().height)}px` : '0px',
      );
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);
}

const unreadList = z.object({ items: z.array(z.object({ id: z.string() }).passthrough()).max(50), nextCursor: z.string().nullable() });
function useUnreadCount(enabled: boolean, path: string): number | null {
  const { api, userId } = useSession();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !userId) {
      setCount(null);
      return;
    }
    const controller = new AbortController();
    const load = () => {
      if (document.hidden) return;
      void api.query('notify', 'notify.list', { limit: 50, unreadOnly: true }, unreadList, { signal: controller.signal }).then((result) => {
        if (!controller.signal.aborted && result.ok) setCount(result.data.items.length + (result.data.nextCursor ? 1 : 0));
      });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, enabled, userId, path]);
  return count;
}

/** Closes a popup on Escape, an outside press and focus leaving it. */
function usePopup() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return { open, setOpen, ref };
}

function NavTab({ tab, current, language }: { tab: TabSpec; current: Door | undefined; language: Parameters<typeof doorLabel>[1] }) {
  const { t } = shellCopy.useCopy();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLLIElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuId = useId();
  const hasMenu = tab.items.length > 0;
  const show = () => {
    clearTimeout(timer.current);
    if (hasMenu) setOpen(true);
  };
  const hideSoon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 140);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <li
      ref={wrapper}
      className={`tb-item ${open ? 'tb-item--open' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={(event) => {
        if (event.target instanceof Element && event.target.matches(':focus-visible')) show();
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && wrapper.current?.contains(event.relatedTarget))) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false);
          link.current?.focus();
        }
      }}
    >
      <a
        ref={link}
        className="tb-tab"
        href={tab.href}
        aria-current={current === tab.door ? 'page' : undefined}
        aria-expanded={hasMenu ? open : undefined}
        aria-controls={hasMenu && open ? menuId : undefined}
        onClick={() => setOpen(false)}
      >
        {doorLabel(tab.door, language)}
        {hasMenu && <ChevronDown size={14} aria-hidden="true" className="tb-chev" />}
      </a>
      {hasMenu && open && (
        // TODO(B1): swap to the Base UI NavigationMenu in @intafaced/ui (same rows, same copy).
        <div className="tb-popover tb-menu" id={menuId}>
          <ul>
            {tab.items.map((item) => (
              <li key={item.id}>
                <a className="tb-menu-item" href={item.href} onClick={() => setOpen(false)}>
                  <ShellIcon name={item.icon} />
                  <span>
                    <strong>{t(item.title)}</strong>
                    <small>{t(item.description)}</small>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function AccountButton({ onSignOut }: { onSignOut: () => void }) {
  const { t } = shellCopy.useCopy();
  const { open, setOpen, ref } = usePopup();
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <div
      className="tb-account"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && ref.current?.contains(event.relatedTarget))) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="tb-icon-button"
        aria-label={t('Account menu')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <ShellIcon name="user" size={18} />
      </button>
      {open && (
        <div className="tb-popover tb-account-menu" id={id}>
          <ul>
            {accountMenu.map((item) => (
              <li key={item.href}>
                <a className="tb-account-item" href={item.href} onClick={() => setOpen(false)}>
                  {t(item.title)}
                </a>
              </li>
            ))}
            <li className="tb-account-divider" role="separator" />
            <li>
              <button
                type="button"
                className="tb-account-item"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                {t('Sign out')}
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "Simple · Pro" segmented control (UI-SPEC 3.1 point 4). Registry-gated. It writes the `layoutMode` preference, so
 * Home and the Trade list change at once; a tooltip says what changes. The bar hides it below 1000 px: the tabs, a 240 px search, bell and account already fill a narrower bar.
 */
function ModeSwitch() {
  const { t } = shellCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const { layoutMode } = usePreferences();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tb-mode max-[1000px]:hidden" />}>
        <SegmentedControl
          size={28}
          aria-label={tp('Switch name')}
          value={layoutMode}
          onValueChange={(value) => savePreferences({ layoutMode: value === 'pro' ? 'pro' : 'simple' })}
          items={[
            { value: 'simple', label: t('Simple') },
            { value: 'pro', label: t('Pro') },
          ]}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        {tp('Switch tip')}
      </TooltipContent>
    </Tooltip>
  );
}

export function TopBar({
  door,
  path,
  onSignOut,
  children,
}: {
  door: Door | undefined;
  path: string;
  onSignOut: () => void;
  children?: ReactNode;
}) {
  const { t } = shellCopy.useCopy();
  const { language, layoutMode } = usePreferences();
  const { session } = useSession();
  useBannerOffset();
  const notificationsLive = isFeatureLive('notifications');
  const unread = useUnreadCount(Boolean(session) && notificationsLive, path);
  const tabs = tabSpecs(layoutMode);
  const signIn = `/login?redirect=${encodeURIComponent(safeReturnTo(currentReturnLocation()))}`;
  return (
    <>
      <header className="tb">
        <a className="tb-brand" href="/home" aria-label={t('Go to Home')}>
          <Wordmark />
        </a>
        <nav className="tb-nav" aria-label={t('Main navigation')}>
          <ul>
            {tabs.map((tab) => (
              <NavTab key={tab.door} tab={tab} current={door} language={language} />
            ))}
          </ul>
        </nav>
        <div className="tb-right">
          <TopSearch />
          {session ? (
            <>
              {isFeatureLive('pro-mode-switch') && <ModeSwitch />}
              {notificationsLive && (
                <a
                  className="tb-icon-button tb-bell"
                  href="/notifications"
                  aria-label={unread ? t('Notifications, {count} unread', { count: unread > 99 ? '99+' : unread }) : t('Notifications')}
                >
                  <ShellIcon name="bell" size={18} />
                  {unread ? <span className="tb-badge">{unread > 99 ? '99+' : unread}</span> : null}
                </a>
              )}
              <AccountButton onSignOut={onSignOut} />
            </>
          ) : (
            <>
              <a className="tb-login" href={signIn}>
                {t('Log in')}
              </a>
              <a className="tb-signup" href="/register">
                {t('Sign up')}
              </a>
            </>
          )}
        </div>
        {children}
      </header>
    </>
  );
}

/** Phone (< 768): the five tabs move to a bottom bar. */
export function MobileTabs({ door, language }: { door: Door | undefined; language: Parameters<typeof doorLabel>[1] }) {
  const { t } = shellCopy.useCopy();
  const { layoutMode } = usePreferences();
  return (
    <nav className="mobile-doors" aria-label={t('Customer doors on phone')}>
      {tabSpecs(layoutMode).map((tab) => (
        <a key={tab.door} href={tab.href} aria-current={door === tab.door ? 'page' : undefined}>
          <ShellIcon name={tab.icon} />
          {doorLabel(tab.door, language)}
        </a>
      ))}
    </nav>
  );
}
