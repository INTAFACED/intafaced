import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Bell, Building2, ChevronsUpDown, Menu, Search } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  StatusTag,
  Wordmark,
  type StatusKind,
} from '@intafaced/ui';
import { navigate } from '../../../../app/location';
import { useSession } from '../../../session/session';
import { useResource } from '../../../../shared/resource';
import { createPortalApi } from '../api';
import { groups } from '../home-layout/Navigation';
import { layoutCopy } from '../home-layout/copy';
import { currentHref } from './model';
import './frames.css';

/** What the business pill says, from the verification status the account already reports. */
function useBusinessStatus(): { kind: StatusKind; label: string } {
  const { api, userId } = useSession();
  const portal = useMemo(() => createPortalApi(api, userId), [api, userId]);
  const { resource } = useResource((signal) => portal.merchant(signal), `portal:frame-business:${userId ?? 'anon'}`);
  if (resource.status !== 'ready' || !resource.data) return { kind: 'working', label: '' };
  switch (resource.data.kybStatus) {
    case 'approved':
      return { kind: 'working', label: 'Verified' };
    case 'pending':
      return { kind: 'pending', label: 'In review' };
    case 'rejected':
      return { kind: 'failed', label: 'Needs attention' };
    default:
      return { kind: 'pending', label: 'Not verified' };
  }
}

/** The business name with its status pill. Opens the list of accounts to switch between. */
function BusinessSwitcher() {
  const status = useBusinessStatus();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="pfo-business" aria-label="Switch account">
        <span className="pfo-business-tile" aria-hidden="true">
          <Building2 size={16} />
        </span>
        <span className="pfo-business-text">
          <span className="pfo-business-name">Your business</span>
          {status.label && <StatusTag status={status.kind} label={status.label} />}
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" className="pfo-business-chevron" />
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Your accounts</DialogTitle>
        <DialogDescription>Choose where you want to work.</DialogDescription>
        <div className="pfo-accounts">
          <a href="/pay/merchant" onClick={() => setOpen(false)}>
            Your business
            <span>Payments, payouts and settings</span>
          </a>
          <a href="/home" onClick={() => setOpen(false)}>
            Personal account
            <span>Balances, transfers and trading</span>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The portal's pages in their groups, for the phone drawer. One item is current; lime marks only that one. */
function SideMenu({ here, close }: { here: string; close?: () => void }) {
  const { t } = layoutCopy.useCopy();
  const current = currentHref(here);
  return (
    <nav className="pfo-menu" aria-label="Business navigation">
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
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="pfo-menu-button" aria-label="Open business menu">
        <Menu size={20} aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="pfo-drawer" closeLabel="Close menu">
        <DialogTitle className="pfo-drawer-title">Your business</DialogTitle>
        <DialogDescription className="pfo-sr">Business navigation</DialogDescription>
        <a href="/home" className="pfo-drawer-back">
          <ArrowLeft size={14} aria-hidden="true" />
          Back to personal
        </a>
        <SideMenu here={here} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PaymentSearch() {
  const [query, setQuery] = useState('');
  return (
    <form
      className="pfo-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const q = query.trim();
        navigate(q ? `/pay/payments?q=${encodeURIComponent(q)}` : '/pay/payments');
      }}
    >
      <Search size={16} aria-hidden="true" />
      <input
        type="search"
        aria-label="Search payments"
        placeholder="Search payments"
        value={query}
        maxLength={200}
        onChange={(e) => setQuery(e.target.value)}
      />
    </form>
  );
}

/** The slim top bar inside the merchant area. It replaces the consumer bar: no market search, no Simple/Pro. */
export function MerchantTopBar({ path, account }: { path: string; account: ReactNode }) {
  return (
    <header className="pfo-top">
      <div className="pfo-phone">
        <PhoneMenu key={path} here={path} />
      </div>
      <a className="pfo-brand" href="/home" aria-label="Go to Home">
        <Wordmark />
      </a>
      <BusinessSwitcher />
      <div className="pfo-top-end">
        <PaymentSearch />
        <a className="pfo-personal" href="/home">
          <ArrowLeft size={14} aria-hidden="true" />
          <span>Back to personal</span>
        </a>
        <Button variant="ghost" size={32} nativeButton={false} render={<a href="/pay/notifications" />} aria-label="Notifications">
          <Bell size={18} aria-hidden="true" />
        </Button>
        {account}
      </div>
    </header>
  );
}
