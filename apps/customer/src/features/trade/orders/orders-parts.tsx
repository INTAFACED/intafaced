import type { ReactNode } from 'react';
import { EmptyState } from '@intafaced/ui/lit';
import { RecordListTemplate, SelectField, Skeleton, type RoomState } from '@intafaced/ui/lit/templates';
import { LinkButton } from '../../../screens/trade/kit-parts';

/**
 * The orders room's parts on the record-list template (intafaced issue 9565): the room itself, the signed-out answer, a
 * filter choice and the waiting rows. Drawn only from the kit, so the spot, futures and venue halves and each order's page
 * read as one room.
 */
const READY: RoomState = { kind: 'ready' };

/** The orders room: its filters above, its records below, Refresh as the room's one action. */
export function OrdersRoomFrame({
  title,
  description,
  action,
  filters,
  list,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  filters?: ReactNode;
  list: ReactNode;
}) {
  return (
    <RecordListTemplate
      title={title}
      description={description}
      state={READY}
      roomAction={action}
      headingMarks={{ 'data-testid': 'page-heading' }}
      filters={filters}
      list={<div className="lt-stack">{list}</div>}
    />
  );
}

/** One order's own page. */
export function OrderPageFrame({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <RecordListTemplate
      title={title}
      description={description}
      state={READY}
      roomAction={action}
      headingMarks={{ 'data-testid': 'page-heading' }}
      list={null}
      detailOnly
      detail={<div className="lt-stack">{children}</div>}
    />
  );
}

/** A visitor who is not signed in: what the room holds, and the way to sign in and come back. */
export function SignedOut({ title, body, signIn, back }: { title: string; body: string; signIn: string; back: string }) {
  return (
    <EmptyState
      title={title}
      body={body}
      action={
        <LinkButton tone="primary" href={`/login?redirect=${encodeURIComponent(back)}`}>
          {signIn}
        </LinkButton>
      }
    />
  );
}

/** Rows on their way; `label` says what. */
export function WaitingRows({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <Skeleton shape="rows" count={4} />
    </div>
  );
}

/** A choice among a filter's values, with "All" first. A value the address holds that is not a choice stays visible. */
export function Pick({
  label,
  value,
  choices,
  words,
  all,
  unknown,
  onPick,
}: {
  label: string;
  value: string;
  choices: readonly string[];
  words: Record<string, string>;
  all: string;
  unknown?: (value: string) => string;
  onPick: (value: string) => void;
}) {
  const stray = unknown && value !== '' && !choices.includes(value);
  return (
    <SelectField
      label={label}
      value={value}
      onChange={onPick}
      options={[
        { value: '', label: all },
        ...choices.map((choice) => ({ value: choice, label: words[choice] ?? choice })),
        ...(stray ? [{ value, label: unknown(value) }] : []),
      ]}
    />
  );
}
