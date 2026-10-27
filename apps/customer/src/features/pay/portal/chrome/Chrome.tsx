import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bell, Building2, ChevronsUpDown, CircleHelp, Menu, Search } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  StatusTag,
  BrandBar,
  type StatusKind,
} from '@intafaced/ui';
import { navigate } from '../../../../app/location';
import { useSharedAccess } from '../access/shared-access';
import { useVisibleGroups } from '../home-layout/Navigation';
import { layoutCopy } from '../home-layout/copy';
import { currentHref } from './model';
import { chromeCopy } from './copy';
import { pageMatches, paymentTarget } from './search';
import './chrome.css';

/** Help articles and support requests are the app's own (`/support`, svc-support): one place for personal and business questions. */
const SUPPORT_HREF = '/support';

/** What the business pill says, from the verification status the account already reports. */
function useBusinessStatus(): { kind: StatusKind; label: string } {
  const { t } = chromeCopy.useCopy();
  const shared = useSharedAccess();
  const access = shared?.access;
  if (!access || access.status !== 'ready' || !access.kybStatus) return { kind: 'working', label: '' };
  switch (access.kybStatus) {
    case 'approved':
      return { kind: 'working', label: t('verified') };
    case 'pending':
      return { kind: 'pending', label: t('inReview') };
    case 'rejected':
      return { kind: 'failed', label: t('needsAttention') };
    default:
      return { kind: 'pending', label: t('notVerified') };
  }
}

/** The business name with its status pill. Opens the list of accounts to switch between. */
function BusinessSwitcher() {
  const { t } = chromeCopy.useCopy();
  const status = useBusinessStatus();
  const access = useSharedAccess()?.access;
  const name = (access?.status === 'ready' && (access.displayName ?? access.legalName)) || t('yourBusiness');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="pfo-business" aria-label={t('switchAccount')}>
        <span className="pfo-business-tile" aria-hidden="true">
          <Building2 size={16} />
        </span>
        <span className="pfo-business-text">
          <span className="pfo-business-name">{name}</span>
          {status.label && <StatusTag status={status.kind} label={status.label} />}
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" className="pfo-business-chevron" />
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{t('yourAccounts')}</DialogTitle>
        <DialogDescription>{t('chooseWhere')}</DialogDescription>
        <div className="pfo-accounts">
          <a href="/pay/merchant" onClick={() => setOpen(false)}>
            {name}
            <span>{t('businessHome')}</span>
          </a>
          <a href="/home" onClick={() => setOpen(false)}>
            {t('personalAccount')}
            <span>{t('personalHome')}</span>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The portal's pages in their groups, for the phone drawer. One item is current; lime marks only that one. */
function SideMenu({ here, close }: { here: string; close?: () => void }) {
  const { t } = layoutCopy.useCopy();
  const { t: tc } = chromeCopy.useCopy();
  const groups = useVisibleGroups();
  const current = currentHref(here);
  return (
    <nav className="pfo-menu" aria-label={tc('businessNavigation')}>
      {groups.map((group) => (
        <section key={group.label}>
          <h2>{t(group.label)}</h2>
          {group.items.map(([href, label]) => (
            <a key={href} href={href} onClick={close} aria-current={href === current ? 'page' : undefined}>
              {t(label)}
            </a>
          ))}
        </section>
      ))}
    </nav>
  );
}

/** Phone: the same menu in a drawer from the left, with the way back to personal at the foot. */
function PhoneMenu({ here }: { here: string }) {
  const { t } = chromeCopy.useCopy();
  const name = useSharedAccess();
  const access = name?.access;
  const title = (access?.status === 'ready' && (access.displayName ?? access.legalName)) || t('yourBusiness');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="pfo-menu-button" aria-label={t('openMenu')}>
        <Menu size={20} aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="pfo-drawer" closeLabel={t('closeMenu')}>
        <DialogTitle className="pfo-drawer-title">{title}</DialogTitle>
        <DialogDescription className="pfo-sr">{t('businessNavigation')}</DialogDescription>
        <a href="/home" className="pfo-drawer-back">
          <ArrowLeft size={14} aria-hidden="true" />
          {t('backToPersonal')}
        </a>
        <SideMenu here={here} close={() => setOpen(false)} />
        <a href={SUPPORT_HREF} className="pfo-drawer-link">
          <CircleHelp size={14} aria-hidden="true" />
          {t('helpSupport')}
        </a>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Search the business pages, or jump to a payment by pasting its ID. Opens from the button or Ctrl/⌘ K, closes on
 * Escape, and hands keyboard focus back to where it was.
 */
function PortalSearch() {
  const { t } = chromeCopy.useCopy();
  const { t: tl } = layoutCopy.useCopy();
  const groups = useVisibleGroups();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen((value) => !value);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const pages = useMemo(
    () => groups.flatMap((group) => group.items.map(([href, label]) => ({ href, label: tl(label), group: tl(group.label) }))),
    [groups, tl],
  );
  const matches = pageMatches(pages, query);
  const payment = paymentTarget(query);
  function change(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery('');
      const back = returnTo.current;
      returnTo.current = null;
      if (back) requestAnimationFrame(() => back.focus());
    }
  }
  function go(href: string) {
    change(false);
    navigate(href);
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger
        className="pfo-search-button"
        aria-label={t('searchLabel')}
        title={t('searchHint')}
        onClick={(event) => {
          returnTo.current = event.currentTarget;
        }}
      >
        <Search size={16} aria-hidden="true" />
        <span>{t('searchPages')}</span>
        <kbd aria-hidden="true">⌘K</kbd>
      </DialogTrigger>
      <DialogContent className="pfo-searchbox" closeLabel={t('closeMenu')}>
        <DialogTitle className="pfo-sr">{t('searchLabel')}</DialogTitle>
        <DialogDescription className="pfo-sr">{t('searchHint')}</DialogDescription>
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const first = payment ?? matches[0]?.href;
            if (first) go(first);
          }}
        >
          <input
            autoFocus
            type="search"
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <ul className="pfo-results">
          {payment && (
            <li>
              <a href={payment} onClick={(event) => (event.preventDefault(), go(payment))}>
                {t('goToPayment', { id: query.trim() })}
              </a>
            </li>
          )}
          {matches.map((page) => (
            <li key={page.href}>
              <a href={page.href} onClick={(event) => (event.preventDefault(), go(page.href))}>
                {page.label}
                <span>{page.group}</span>
              </a>
            </li>
          ))}
          {!payment && matches.length === 0 && <li className="pfo-results-empty">{t('searchNothing')}</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** The slim top bar inside the merchant area. It replaces the consumer bar: no market search, no Simple/Pro. */
export function MerchantTopBar({ path, account }: { path: string; account: ReactNode }) {
  const { t } = chromeCopy.useCopy();
  return (
    <header className="pfo-top" data-obscures="top">
      <div className="pfo-phone">
        <PhoneMenu key={path} here={path} />
      </div>
      <a className="pfo-brand" href="/home" aria-label={t('goToHome')}>
        <BrandBar />
      </a>
      <BusinessSwitcher />
      <div className="pfo-top-end">
        <PortalSearch />
        <a className="pfo-personal" href="/home">
          <ArrowLeft size={14} aria-hidden="true" />
          <span>{t('backToPersonal')}</span>
        </a>
        <Button variant="ghost" size={32} nativeButton={false} role="link" render={<a href={SUPPORT_HREF} />} aria-label={t('helpSupport')}>
          <CircleHelp size={18} aria-hidden="true" />
        </Button>
        <Button variant="ghost" size={32} nativeButton={false} render={<a href="/pay/notifications" />} aria-label={t('notifications')}>
          <Bell size={18} aria-hidden="true" />
        </Button>
        {account}
      </div>
    </header>
  );
}
