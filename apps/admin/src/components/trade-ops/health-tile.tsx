import Link from 'next/link';
import type { ReactNode } from 'react';
import { Stat, StatusChip } from '@intafaced/ui';

/**
 * One tile on the Health overview. It has its own state (Live, Unknown or Refused, always a word and a shape),
 * its own figure, and a link to the room that fixes it. A tile whose read failed shows the dash and the service's
 * words, never a zero. Tiles never depend on each other, so one failing tile cannot blank the rest.
 */
export function HealthTile(props: {
  title: string;
  state: 'live' | 'unknown' | 'refused';
  /** ISO time the tile's data was read. */
  asOf?: string | null;
  /** The headline figure, pre-formatted; null = unknown. */
  value: string | null;
  /** Plain-words reason when the state is not live. */
  reason?: string;
  /** Service code or owner · requirement id shown small under the figure. */
  code?: string;
  /** Extra plain lines (counts, notes). */
  lines?: readonly ReactNode[];
  href: string;
  linkLabel: string;
}) {
  return (
    <section
      aria-label={props.title}
      data-tile-state={props.state}
      className="flex min-w-0 flex-col gap-2 rounded-sm border border-line bg-panel p-3"
    >
      <Stat label={props.title} value={props.value} size="md" density="dense" />
      <StatusChip
        kind={props.state}
        asOf={props.asOf ?? undefined}
        showAsOf={props.state === 'live'}
        reason={props.reason}
        density="dense"
      />
      {props.reason ? <p className="text-xs text-fg-2">{props.reason}</p> : null}
      {props.code ? <p className="if-num text-2xs text-fg-3">{props.code}</p> : null}
      {props.lines?.map((line, i) => (
        <p key={i} className="text-xs text-fg-2">
          {line}
        </p>
      ))}
      <Link
        href={props.href}
        className="mt-auto text-xs font-medium text-fg-2 underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-lime"
      >
        {props.linkLabel}
      </Link>
    </section>
  );
}
