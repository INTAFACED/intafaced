import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Tabs } from '@intafaced/ui/lit/templates';
import { t as copyText, Text } from '../copy';
import { bankLabels, bankRoomHref, bankRooms, shownBankRooms } from './bank-rooms';

/**
 * The Bank's frame for a room on a Volt template, drawn from the kit: the same words and controls as the old `BankPage`
 * (rooms.tsx) and the money parts it used (`Section`, `NoRows`, `Continuation` in components.tsx).
 */
type BankRoom = (typeof bankRooms)[number];

/** The template's title, description and room action ("Bank overview") for one Bank room. */
export function bankRoomProps(room: BankRoom, description: string, title?: string) {
  return {
    title: title ?? copyText(bankLabels[room]),
    description,
    roomAction:
      room !== 'Ramps' ? (
        <a className="lt-button lt-button-secondary" href="/bank">
          <Text k="rooms.bank.overview" />
        </a>
      ) : undefined,
  };
}

/** Where the room sits ("Money / Bank", unless the page's eyebrow says it: `where`) and the Bank's nine rooms, the route's own lit (none on a room it does not list). */
export function BankTabs({ where = true }: { where?: boolean }) {
  return (
    <div data-testid="money-bank-nav">
      {where ? (
        <p className="lt-hint">
          <Text k="rooms.money.bank" />
        </p>
      ) : null}
      <Tabs
        label={copyText('rooms.bank.rooms')}
        items={shownBankRooms().map((room) => ({ label: copyText(bankLabels[room]), href: bankRoomHref(room) }))}
      />
    </div>
  );
}

/** One titled part of a Bank room, with its own actions. */
export function BankSection({
  title,
  description,
  actions,
  children,
  label,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** The section's accessible name, when its title is not plain text. */
  label?: string;
}) {
  return (
    <section aria-label={label}>
      <header className="lt-title-row lt-title-row-wrap">
        <div>
          <h2>{title}</h2>
          {description && <p className="lt-description">{description}</p>}
        </div>
        {actions && <div className="lt-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** A list the bank returned empty, with what it means. */
export function NoRows({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="lt-empty">
      <p className="lt-empty-title">{title}</p>
      {children && <p className="lt-empty-body">{children}</p>}
    </div>
  );
}

/** How many records came back, what that means for the rest, and Load up to the next 50 while the service allows it. */
export function Continuation({ count, limit, onMore }: { count: number; limit: number; onMore: () => void }) {
  return (
    <div className="lt-actions">
      <p className="lt-hint">
        {count}
        <Text k="components.records.returned.requested.limit" />.{' '}
        {count >= limit
          ? limit < 200
            ? copyText('components.more.records.may.exist')
            : copyText('components.this.service.has.no.continuation.beyond.200')
          : copyText('components.this.list.has.no.total.count.or')}
      </p>
      {count >= limit && limit < 200 && (
        <Button tone="secondary" onClick={onMore}>
          <Text k="components.load.up.to" />
          {Math.min(200, limit + 50)}
        </Button>
      )}
    </div>
  );
}
