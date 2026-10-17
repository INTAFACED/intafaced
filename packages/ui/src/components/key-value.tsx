import * as React from 'react';
import { cn } from './cn.js';
import { type Density, DEFAULT_DENSITY } from './density.js';
import { type AsOf, asOfIso, formatAsOf } from './freshness.js';
import { UNKNOWN } from './numbers.js';

export interface KeyValueItem {
  /** Stable React key. Defaults to the label. */
  key?: string;
  label: string;
  /** Pre-formatted text. null = unknown: draws the dash with an sr-only "unknown", never 0. */
  value: string | null;
  hint?: string;
  /** IDs, addresses and references: uses the mono face. */
  mono?: boolean;
  /** When this value was read; drawn small under the value as "as of 14:03:07". */
  asOf?: AsOf;
}

export interface KeyValueProps extends Omit<React.ComponentProps<'dl'>, 'children'> {
  items: KeyValueItem[];
  /** inline = label left, value right in a fixed lane; stacked = label above value. */
  layout?: 'inline' | 'stacked';
  density?: Density;
  /** Replaces the English sr-only word read for a dash. */
  unknownLabel?: string;
  /** Replaces the English "as of". */
  asOfLabel?: string;
  /** Used to format item asOf times. Undefined = the viewer's zone and locale. */
  timeZone?: string;
  locale?: string;
  /** Epoch ms; only decides whether an item asOf shows its date as well. */
  now?: number;
}

/** Label / value rows for detail panes and receipts, as a real description list with hairline separators. */
export function KeyValue({
  items,
  layout = 'inline',
  density = DEFAULT_DENSITY,
  unknownLabel = 'unknown',
  asOfLabel = 'as of',
  timeZone,
  locale,
  now,
  className,
  ...props
}: KeyValueProps) {
  const stacked = layout === 'stacked';
  return (
    <dl
      data-slot="key-value"
      data-layout={layout}
      data-density={density}
      className={cn('m-0 grid', stacked ? 'grid-cols-1' : 'grid-cols-[auto_minmax(0,1fr)] gap-x-4', className)}
      {...props}
    >
      {items.map((item) => {
        const iso = asOfIso(item.asOf);
        const shown = iso ? formatAsOf(item.asOf, { timeZone, locale, now }) : null;
        return (
          <div
            key={item.key ?? item.label}
            data-slot="key-value-row"
            className={cn(
              'border-b border-line py-1 last:border-b-0',
              density === 'dense' ? 'min-h-7' : 'min-h-10',
              stacked ? 'flex flex-col justify-center gap-0.5' : 'col-span-2 grid grid-cols-subgrid items-center',
            )}
          >
            <dt className={cn('text-fg-2', density === 'dense' ? 'text-xs' : 'text-sm')}>{item.label}</dt>
            <dd
              data-unknown={item.value == null || undefined}
              className={cn(
                'm-0 min-w-0',
                density === 'dense' ? 'text-sm' : 'text-base',
                stacked ? 'text-left' : 'text-right',
                'tabular-nums',
                item.mono ? 'if-mono break-all' : 'if-num',
              )}
            >
              {item.value == null ? (
                <>
                  <span aria-hidden="true" className="text-fg-2">
                    {UNKNOWN}
                  </span>
                  <span className="sr-only">{unknownLabel}</span>
                </>
              ) : (
                item.value
              )}
              {item.hint ? <span className="block text-xs text-fg-2">{item.hint}</span> : null}
              {iso && shown ? (
                <span className="block text-xs text-fg-2">
                  {asOfLabel} <time dateTime={iso}>{shown}</time>
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
