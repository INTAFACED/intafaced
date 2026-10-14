'use client';
/**
 * One line of the Inbox. A single piece of markup that reads as a dense table row when its list is wide (36-40 px) and as a
 * three-line card when the list is narrow (a phone, or the list beside an open person). The switch follows the width of the
 * list itself (a container query), not the window.
 */
import { Tooltip, TooltipContent, TooltipTrigger, cn } from '@intafaced/ui';
import { answerText, investorSignals, otherSignal } from './answers';
import { audienceLabel, formatMoney, formatMoneyCompact, stageLabel } from './format';
import type { RowInfo } from './use-row-info';
import { SEVERITY_WORD, nextActionLine, waitSeverity, waitingText, type QueueEntry, type WaitSeverity } from './queue';
import { OwnerInitial, Tag } from './ui';

export type RowVariant = 'investor' | 'other' | 'mixed';

/** Column templates once the list is at least 760 px wide. */
const WIDE: Record<RowVariant, string> = {
  investor: '@min-[760px]:grid-cols-[96px_minmax(0,1.5fr)_88px_minmax(0,1.5fr)_minmax(0,1.3fr)_44px_88px]',
  other: '@min-[760px]:grid-cols-[96px_minmax(0,1.5fr)_96px_minmax(0,1.3fr)_minmax(0,1.3fr)_44px]',
  mixed: '@min-[760px]:grid-cols-[96px_minmax(0,1.5fr)_96px_minmax(0,1.3fr)_minmax(0,1.3fr)_44px_88px]',
};

export const COLUMN_HEADS: Record<RowVariant, string[]> = {
  investor: ['Waiting', 'Person', 'Indicated', 'Type · role · timing · source', 'Next action', 'Owner', 'Stage'],
  other: ['Waiting', 'Person', 'Audience', 'Key signal', 'Next action', 'Owner'],
  mixed: ['Waiting', 'Person', 'Audience', 'Key signal', 'Next action', 'Owner', 'Stage'],
};

/** Column headings, shown only while the list is wide enough for columns. */
export function RowHeader({ variant }: { variant: RowVariant }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'hidden items-center gap-x-3 border-b border-line px-3 py-1.5 text-2xs font-medium tracking-wide text-fg-3 uppercase @min-[760px]:grid',
        WIDE[variant],
      )}
    >
      {COLUMN_HEADS[variant].map((head) => (
        <span key={head} className={cn('truncate', head === 'Indicated' && 'text-right')}>
          {head}
        </span>
      ))}
    </div>
  );
}

const severityClass: Record<WaitSeverity, string> = {
  ok: 'text-fg',
  late: 'text-warn-text',
  very_late: 'text-down-text',
};

/** The age ("3d") with a word beside it once it is late, so colour is never the only signal. */
export function WaitCell({ since, audience, now }: { since: string | null; audience: string; now: number }) {
  const severity = waitSeverity(audience, since, now);
  const word = SEVERITY_WORD[severity];
  const age = waitingText(since, now);
  return (
    <span
      className={cn('flex items-baseline gap-1.5 tabular-nums @min-[760px]:flex-wrap', severityClass[severity])}
      aria-label={word ? `Waiting ${age}, ${word.toLowerCase()}` : `Waiting ${age}`}
    >
      <span className="text-md font-medium">{age}</span>
      {word ? <span className="text-2xs font-medium">{word}</span> : null}
    </span>
  );
}

function PersonCell({ entry }: { entry: QueueEntry }) {
  const name = entry.contact?.name ?? 'Open enquiry';
  return (
    <span className="block min-w-0 truncate text-left" title={entry.contact?.email}>
      <span className="font-medium text-fg">{name}</span>
      {entry.organisation ? <span className="text-fg-2"> · {entry.organisation}</span> : null}
      {entry.alias ? <span className="text-fg-3"> · also: {entry.alias}</span> : null}
      {entry.partial ? (
        <span className="ml-1.5 text-2xs text-fg-3" title="Partly answered: questionnaires not finished">
          Partial
        </span>
      ) : null}
    </span>
  );
}

/** The indicated amount, muted, with a tooltip saying it is what the person told us. */
export function IndicatedAmount({ amount, currency, className }: { amount: string; currency: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={cn('tabular-nums text-fg-2', className)}
        aria-label={`${formatMoney(amount, currency)}, self-reported`}
      >
        {formatMoneyCompact(amount, currency)}
      </TooltipTrigger>
      <TooltipContent>Self-reported. What they told us, not confirmed by us.</TooltipContent>
    </Tooltip>
  );
}

export function InboxRow({
  entry,
  variant,
  info,
  founder,
  now,
  selected,
  disabled,
  onOpen,
}: {
  entry: QueueEntry;
  variant: RowVariant;
  info: RowInfo | undefined;
  /** The owner's name. */
  founder: string;
  now: number;
  selected: boolean;
  disabled?: boolean;
  onOpen: (id: string) => void;
}) {
  const { row } = entry;
  const next = nextActionLine(row, now);
  const stated = row.audience === 'investor' && row.indicativeContribution.status === 'stated' ? row.indicativeContribution : null;
  const loadingInfo = info === undefined;
  const investor = investorSignals(info?.answers ?? null);
  const signalParts =
    row.audience === 'investor'
      ? [investor.type, investor.role, investor.timing, info?.source ?? null].filter((part): part is string => Boolean(part))
      : [];
  const other = row.audience === 'investor' ? null : otherSignal(row.audience, info?.answers ?? null);
  const timing = row.audience === 'investor' ? null : answerText('timing', info?.answers?.timing);

  const signalText =
    variant === 'investor' || row.audience === 'investor'
      ? signalParts.join(' · ')
      : [other, variant === 'mixed' ? null : timing].filter(Boolean).join(' · ');
  const placeholder = loadingInfo ? '…' : '—';

  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        data-enquiry-id={row.id}
        aria-current={selected ? 'true' : undefined}
        disabled={disabled}
        onClick={() => onOpen(row.id)}
        className={cn(
          'grid w-full grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left text-base text-fg',
          '@min-[760px]:min-h-10 @min-[760px]:py-1.5 max-[600px]:min-h-[76px]',
          'transition-colors duration-(--if-t-fast) ease-if hover:bg-hover disabled:cursor-wait',
          'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lime',
          selected && 'bg-raised hover:bg-raised',
          WIDE[variant],
        )}
      >
        {/* Waiting */}
        <span className="col-start-1 row-span-3 row-start-1 self-start pt-0.5 @min-[760px]:row-span-1 @min-[760px]:self-center @min-[760px]:pt-0">
          <WaitCell since={row.waitingSince} audience={row.audience} now={now} />
        </span>
        {/* Person */}
        <span className="col-start-2 row-start-1 min-w-0 @min-[760px]:col-start-2">
          <PersonCell entry={entry} />
        </span>
        {/* Right-hand tag on a narrow row: the stage, or the audience for people who are not investors. */}
        <span className="col-start-3 row-start-1 justify-self-end @min-[760px]:hidden">
          {variant === 'other' ? <Tag>{audienceLabel(row.audience)}</Tag> : <Tag dot>{stageLabel(row.stage)}</Tag>}
        </span>
        {/* Amount, then the signals. In a wide list each is its own column; in a narrow one they share a line. */}
        <span className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm text-fg-2 @min-[760px]:contents">
          {variant === 'investor' ? (
            <span className="@min-[760px]:col-start-3 @min-[760px]:row-start-1 @min-[760px]:text-right">
              {stated ? <IndicatedAmount amount={stated.amount} currency={stated.currency} /> : <span className="text-fg-3">—</span>}
            </span>
          ) : (
            <span className="hidden @min-[760px]:col-start-3 @min-[760px]:row-start-1 @min-[760px]:block">
              <Tag>{audienceLabel(row.audience)}</Tag>
            </span>
          )}
          <span className="min-w-0 truncate @min-[760px]:col-start-4 @min-[760px]:row-start-1" title={signalText || undefined}>
            {variant === 'mixed' && stated ? (
              <>
                <IndicatedAmount amount={stated.amount} currency={stated.currency} />
                {signalText ? ' · ' : ''}
              </>
            ) : null}
            {signalText || (variant === 'mixed' && stated ? '' : placeholder)}
          </span>
        </span>
        {/* Next action */}
        <span className="col-start-2 row-start-3 flex min-w-0 items-baseline gap-2 text-sm @min-[760px]:col-start-5 @min-[760px]:row-start-1">
          {next ? (
            <>
              <span className="min-w-0 truncate text-fg" title={next.description}>
                {next.description}
              </span>
              <span className={cn('shrink-0 whitespace-nowrap', next.overdue ? 'font-medium text-lime' : 'text-fg-2')}>
                {next.overdue ?? next.when.replace(/^Due /, 'due ')}
              </span>
            </>
          ) : (
            <span className="text-fg-3">—</span>
          )}
        </span>
        {/* Owner */}
        <span className="col-start-3 row-start-3 justify-self-end @min-[760px]:col-start-6 @min-[760px]:row-start-1 @min-[760px]:justify-self-auto">
          <OwnerInitial name={founder} />
        </span>
        {/* Stage, in a wide list */}
        {variant !== 'other' ? (
          <span className="hidden @min-[760px]:col-start-7 @min-[760px]:row-start-1 @min-[760px]:block">
            <Tag dot>{stageLabel(row.stage)}</Tag>
          </span>
        ) : null}
      </button>
    </li>
  );
}
