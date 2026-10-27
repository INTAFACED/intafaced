import { Suspense, lazy, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { SegmentedControl, Tooltip, TooltipContent, TooltipTrigger, Wordmark } from '@intafaced/ui';
import { useSession } from '../features/session/session';
import { usePreferences, savePreferences } from '../shared/preferences';
import { proCopy } from '../screens/home/pro-copy';
import { BellPopover } from '../screens/notifications/BellPopover';
import { currentReturnLocation } from './location';
import { doorLabel, safeReturnTo, type Door } from './navigation';
import { isFeatureLive } from './feature-registry';
import { ShellIcon } from './icons';
import { menuItemWords, MOBILE_DOOR_ORDER, tabSpecs, type MenuItem, type TabSpec } from './menus';
import { shellCopy } from './shell-copy';
import { AccountMenuBody } from './AccountMenu';
import { ProfileChip } from './ProfileChip';
import { TopSearch } from './TopSearch';
import { isMerchantArea } from '../features/pay/portal/chrome/model';
import { groups } from '../features/pay/portal/home-layout/groups';
import { ShellSwitch } from '../features/protocol/ShellSwitch';

// The merchant portal's chrome and menu load only when a merchant page or the Pay menu needs them.
export const preloadMerchantChrome = () => import('../features/pay/portal/chrome/Chrome').then((m) => ({ default: m.MerchantTopBar }));
const MerchantTopBar = lazy(preloadMerchantChrome);
const GroupedMenu = lazy(() => import('../features/pay/portal/home-layout/Navigation').then((m) => ({ default: m.GroupedMenu })));

/** Sets `--if-banner-offset` to the local stack's banner height (28 px), or 0 when there is no banner, and marks the banner as covering the top edge. */
export function useBannerOffset() {
  useEffect(() => {
    const apply = () => {
      const banner = document.getElementById('local-test-stack-banner');
      // The fixed banner covers the top edge too, so the Lit look's focus padding counts it (a11y trackObscuringBars).
      if (banner && !banner.hasAttribute('data-obscures')) banner.setAttribute('data-obscures', 'top');
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

function MenuRow({ item, close, language }: { item: MenuItem; close: () => void; language: Parameters<typeof doorLabel>[1] }) {
  const { t } = shellCopy.useCopy();
  const words = menuItemWords(item, t, language);
  return (
    <li>
      <a className="tb-menu-item" href={item.href} onClick={close}>
        <ShellIcon name={item.icon} />
        <span>
          <strong>{words.title}</strong>
          <small>{words.description}</small>
        </span>
      </a>
    </li>
  );
}

function NavTab({ tab, current, language }: { tab: TabSpec; current: Door | undefined; language: Parameters<typeof doorLabel>[1] }) {
  const { t } = shellCopy.useCopy();
  const { layoutMode } = usePreferences();
  // Simple mode puts the advanced desks under a heading; Pro lists every row in one flat list. Every row is still a link either way.
  const mainItems = tab.items.filter((item) => layoutMode === 'pro' || !item.group);
  const advancedItems = layoutMode === 'pro' ? [] : tab.items.filter((item) => item.group === 'Advanced');
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLLIElement>(null);
  const link = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuId = useId();
  const groupedPay =
    tab.door === 'Pay' &&
    groups.some((g) => g.items.some(([href]) => location.pathname === href || location.pathname.startsWith(href + '/')));
  const hasMenu = Boolean(groupedPay) || tab.items.length > 0;
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
      data-testid="tb-item"
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
        data-testid="tb-tab"
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
        <div data-testid="tb-menu" className="tb-popover tb-menu" id={menuId} role="group" aria-label={doorLabel(tab.door, language)}>
          {groupedPay ? (
            <Suspense fallback={null}>
              <GroupedMenu here={location.pathname} close={() => setOpen(false)} />
            </Suspense>
          ) : (
            <>
              <ul>
                {mainItems.map((item) => (
                  <MenuRow key={item.id} item={item} close={() => setOpen(false)} language={language} />
                ))}
              </ul>
              {advancedItems.length > 0 && (
                <>
                  <p className="tb-menu-group">{t('Advanced')}</p>
                  <ul aria-label={t('Advanced')}>
                    {advancedItems.map((item) => (
                      <MenuRow key={item.id} item={item} close={() => setOpen(false)} language={language} />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
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
          <AccountMenuBody close={() => setOpen(false)} onSignOut={onSignOut} />
        </div>
      )}
    </div>
  );
}

/**
 * "Simple · Pro" segmented control (UI-SPEC 3.1 point 4). Registry-gated. It writes the `layoutMode` preference, so
 * Home and the Trade list change at once; a tooltip says what changes. The bar hides it below 1000 px: the tabs, a 240 px search, bell and account already fill a narrower bar. There the same control sits in the account menu (`ModeRow`), so a person who picked Pro on a laptop can still go back to Simple on a phone.
 */
function ModeControl() {
  const { t } = shellCopy.useCopy();
  const { t: tp } = proCopy.useCopy();
  const { layoutMode } = usePreferences();
  return (
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
  );
}

function ModeSwitch() {
  const { t: tp } = proCopy.useCopy();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tb-mode max-[1000px]:hidden" />}>
        <ModeControl />
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
  const { session, restoring } = useSession();
  useBannerOffset();
  const notificationsLive = isFeatureLive('notifications');
  const tabs = tabSpecs(layoutMode, Boolean(session) || restoring);
  const here = typeof location === 'undefined' ? path : path + location.search;
  const signIn = `/login?redirect=${encodeURIComponent(safeReturnTo(currentReturnLocation()))}`;
  if (isMerchantArea(path))
    return (
      <Suspense fallback={null}>
        <MerchantTopBar path={path} account={<AccountButton onSignOut={onSignOut} />} />
      </Suspense>
    );
  return (
    <>
      <header data-testid="tb" className="tb" data-obscures="top">
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
        <div data-testid="tb-right" className="tb-right">
          {/* The bar has room for the switch from 1280 px; narrower, it is in the account menu, or signed out in the row below. */}
          <ShellSwitch current="exchange" here={here} className="max-[1280px]:hidden" />
          <TopSearch />
          {session ? (
            <>
              {isFeatureLive('pro-mode-switch') && <ModeSwitch />}
              {notificationsLive && <BellPopover path={path} />}
              <ProfileChip />
              <AccountButton onSignOut={onSignOut} />
            </>
          ) : restoring ? (
            // The boot refresh has not answered: show neither the signed-in controls nor Log in / Sign up.
            <span className="tb-restoring" aria-hidden="true" />
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
      {session ? null : (
        <div className="tb-switch-row min-[1280px]:hidden">
          <ShellSwitch current="exchange" here={here} />
        </div>
      )}
    </>
  );
}

/** Phone (< 768): the five doors move to a bottom bar, in the computer's order: Home, Money, Trade, Pay, More. */
export function MobileTabs({ door, language }: { door: Door | undefined; language: Parameters<typeof doorLabel>[1] }) {
  const { t } = shellCopy.useCopy();
  const { layoutMode } = usePreferences();
  const { session, restoring } = useSession();
  const tabs = tabSpecs(layoutMode, Boolean(session) || restoring);
  return (
    <nav className="mobile-doors" data-obscures="bottom" aria-label={t('Customer doors on phone')}>
      {MOBILE_DOOR_ORDER.map((name) => tabs.find((tab) => tab.door === name)).flatMap((tab) =>
        tab
          ? [
              <a key={tab.door} href={tab.href} aria-current={door === tab.door ? 'page' : undefined}>
                <ShellIcon name={tab.icon} />
                {doorLabel(tab.door, language)}
              </a>,
            ]
          : [],
      )}
    </nav>
  );
}
