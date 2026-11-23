/**
 * Payee: the person money is about to go to, as the service found them: a round face with their initial, the name on
 * their profile, their handle, a badge the service confirmed (member since...), and a tick once they are confirmed.
 * Everything shown comes from the lookup, never guessed: a person with no name shared shows only what was given. Words
 * arrive as props (a room wraps a value in its own element when a test finds it there).
 */
import * as React from 'react';
import { clsx } from 'clsx';

export type PayeeProps = {
  /** The words the face's letter is taken from: the name, else the handle. */
  face: string;
  /** The name on their profile. */
  name?: React.ReactNode;
  /** Their handle, as it is written ("@mika"). */
  handle?: React.ReactNode;
  /** A fact the service confirmed about them ("Member since Nov 2026"). */
  badge?: React.ReactNode;
  /** The lookup found exactly this person: a tick after the line. */
  confirmed?: boolean;
  className?: string;
  'data-testid'?: string;
};

/** The first letter of the first word, upper case; a mark when there is none. */
const initial = (words: string) => ([...words.trim().replace(/^@/, '')][0] ?? '#').toLocaleUpperCase();

export function Payee({ face, name, handle, badge, confirmed, className, 'data-testid': testId }: PayeeProps) {
  return (
    <span className={clsx('lit-payee', className)} data-slot="payee" data-confirmed={confirmed ? '' : undefined} data-testid={testId}>
      <span data-part="face" aria-hidden="true">
        {initial(face)}
      </span>
      <span data-part="who">
        {name ? <span data-part="name">{name}</span> : null}
        {handle ? <span data-part="handle">{handle}</span> : null}
      </span>
      {badge ? <span data-part="badge">{badge}</span> : null}
      {confirmed ? (
        <svg
          data-part="tick"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : null}
    </span>
  );
}
