/**
 * Gallery section for Stat, KeyValue, Badge and StatusChip. TEST DATA only: every figure and
 * timestamp is fixed sample text, and `now` is pinned so the stale examples never change.
 */
import * as React from 'react';
import { Clock } from 'lucide-react';
import { Badge, type BadgeTone } from '../../badge.js';
import { type Freshness, type HeldState, totalFreshness } from '../../freshness.js';
import { HeldMark } from '../../held-mark.js';
import { KeyValue } from '../../key-value.js';
import { HideBalancesProvider } from '../../numbers.js';
import { Stat } from '../../stat.js';
import { StatusChip } from '../../status-chip.js';

// TEST timestamps. NOW is pinned: 2026-10-17 14:05:00 UTC.
const NOW = Date.UTC(2026, 9, 17, 14, 5, 0);
const LIVE_AT = '2026-10-17T14:04:30Z';
const STALE_AT = '2026-10-17T13:41:07Z';
const OLD_DAY_AT = '2026-10-15T09:12:44Z';
const STALE_AFTER = 5 * 60_000;
// Page-load time, read once: the one example that runs on a real clock (no `now`), so it must turn Stale by itself.
const LOADED_AT = Date.now();
const TZ = { timeZone: 'UTC', locale: 'en-GB' } as const;

const TONES: BadgeTone[] = ['neutral', 'lime', 'warn', 'error', 'up', 'down'];
const KINDS: Freshness[] = ['live', 'stale', 'unknown', 'refused'];
const DENSITIES = ['dense', 'comfortable'] as const;

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-fg-2">{title}</h3>
      {children}
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="text-2xs text-fg-2">{children}</span>;
}

export function FiguresSection() {
  return (
    <section className="flex flex-col gap-6 border-t border-line py-8" data-testid="figures-section">
      <h2 className="text-lg font-semibold">
        Figures: Stat, KeyValue, Badge, StatusChip, HeldMark <span className="text-warn">TEST DATA</span>
      </h2>

      <Part title="Badge: every tone, soft and outline, both densities">
        {DENSITIES.map((density) =>
          (['soft', 'outline'] as const).map((variant) => (
            <div key={`${density}-${variant}`} className="flex flex-wrap items-center gap-6">
              <Caption>
                {density} / {variant}
              </Caption>
              {TONES.map((tone) => (
                <Badge key={tone} tone={tone} variant={variant} density={density}>
                  {tone}
                </Badge>
              ))}
              <Badge variant={variant} density={density} icon={<Clock className="size-3" />}>
                With icon
              </Badge>
            </div>
          )),
        )}
      </Part>

      <Part title="StatusChip: every kind, both densities (pinned now 14:05:00 UTC)">
        {DENSITIES.map((density) => (
          <div key={density} className="flex flex-wrap items-center gap-6">
            <Caption>{density}</Caption>
            {KINDS.map((kind) => (
              <StatusChip key={kind} kind={kind} density={density} />
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-6">
          <Caption>derived from timestamps, as-of shown</Caption>
          <StatusChip asOf={LIVE_AT} now={NOW} staleAfterMs={STALE_AFTER} showAsOf {...TZ} />
          <StatusChip asOf={STALE_AT} now={NOW} staleAfterMs={STALE_AFTER} showAsOf {...TZ} />
          <StatusChip asOf={OLD_DAY_AT} now={NOW} staleAfterMs={STALE_AFTER} showAsOf {...TZ} />
          <StatusChip asOf={null} now={NOW} staleAfterMs={STALE_AFTER} showAsOf {...TZ} reason="No timestamp from the feed (TEST)" />
          <StatusChip asOf={LIVE_AT} now={NOW} staleAfterMs={STALE_AFTER} refused showAsOf {...TZ} reason="Source refused (TEST)" />
          <StatusChip kind="live" labels={{ live: 'En direct' }} />
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <Caption>ticks: turns Stale after 2 s (TEST)</Caption>
          <StatusChip asOf={LOADED_AT} staleAfterMs={2000} showAsOf {...TZ} data-testid="ticking-chip" />
        </div>
      </Part>

      <Part title="Stat: sizes, density, align, delta, freshness, loading, hidden">
        {DENSITIES.map((density) => (
          <div key={density} className="flex flex-wrap items-start gap-6">
            <Caption>{density}</Caption>
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <Stat key={size} label={`Size ${size}`} value="1,234.50" unit="USD" size={size} density={density} hint="TEST DATA" />
            ))}
            <Stat label="Up" value="83,281.8" delta="+1.24%" density={density} />
            <Stat label="Down" value="83,281.8" delta="−0.28%" density={density} />
            <Stat label="Unknown" value={null} density={density} />
            <Stat label="Align end" value="42.00" align="end" density={density} />
          </div>
        ))}
        <div className="flex flex-wrap items-start gap-6">
          <Caption>freshness</Caption>
          <Stat label="Live" value="100.00" asOf={LIVE_AT} now={NOW} staleAfterMs={STALE_AFTER} {...TZ} />
          <Stat label="Stale" value="100.00" asOf={STALE_AT} now={NOW} staleAfterMs={STALE_AFTER} {...TZ} />
          <Stat label="Unknown" value={null} asOf={null} now={NOW} staleAfterMs={STALE_AFTER} reason="No timestamp (TEST)" {...TZ} />
          <Stat label="Refused" value={null} refused now={NOW} reason="Source refused (TEST)" {...TZ} />
          <Stat label="Loading" value="100.00" loading />
          <HideBalancesProvider hidden>
            <Stat label="Hidden (sensitive)" value="1,234.50" delta="+1.24%" sensitive />
          </HideBalancesProvider>
        </div>
      </Part>

      <Part title="HeldMark: one figure per holder in its four states, side by side, and a total across holders (pinned now 14:05:00 UTC)">
        <HeldFigures />
      </Part>

      <Part title="KeyValue: inline and stacked, both densities">
        <div className="flex flex-wrap items-start gap-6">
          {DENSITIES.map((density) =>
            (['inline', 'stacked'] as const).map((layout) => (
              <div key={`${density}-${layout}`} className="w-80">
                <Caption>
                  {density} / {layout}
                </Caption>
                <KeyValue
                  density={density}
                  layout={layout}
                  {...TZ}
                  now={NOW}
                  items={[
                    { label: 'Order ID', value: 'TEST-7F3A-0001', mono: true },
                    { label: 'Amount', value: '1,234.50 USD', hint: 'TEST DATA' },
                    { label: 'Rate', value: '83,281.8', asOf: LIVE_AT },
                    { label: 'Old rate', value: '82,900.0', asOf: OLD_DAY_AT },
                    { label: 'Venue', value: null },
                  ]}
                />
              </div>
            )),
          )}
        </div>
      </Part>
    </section>
  );
}

// TEST holders and figures for the HeldMark example: two holders under one header, each part in its own state.
const HELD_PARTS: Array<{ holder: string; value: string | null; state: HeldState; asOf: string | null; route?: string }> = [
  { holder: 'Partner account (TEST)', value: '1,000.00 USDC', state: 'known', asOf: LIVE_AT },
  { holder: 'Venue account (TEST)', value: '500.00 USDC', state: 'stale', asOf: STALE_AT },
  { holder: 'Card partner (TEST)', value: null, state: 'unknown', asOf: null },
  {
    holder: 'Moving (TEST)',
    value: '250.00 USDC',
    state: 'transit',
    asOf: LIVE_AT,
    route: 'From the partner account to the venue account',
  },
];
const asOfText = (iso: string) => `As of ${iso.slice(11, 19)} UTC`;

function HeldFigures() {
  const known = HELD_PARTS.filter((part) => part.state !== 'unknown');
  const total = totalFreshness(HELD_PARTS);
  const totalKnown = totalFreshness(known);
  return (
    <div className="flex flex-wrap items-start gap-10">
      <ul className="flex w-96 flex-col gap-2" data-testid="held-parts">
        {HELD_PARTS.map((part) => (
          <li key={part.holder} className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm">{part.holder}</span>
              <HeldMark state={part.state} asOf={part.asOf} asOfText={part.asOf ? asOfText(part.asOf) : undefined} route={part.route} />
            </span>
            {part.value === null ? (
              <span className="shrink-0 whitespace-nowrap text-sm text-fg-2">Not known</span>
            ) : (
              <span className="if-num shrink-0 whitespace-nowrap text-sm tabular-nums">{part.value}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex w-80 flex-col gap-3">
        <div className="flex flex-col gap-1" data-testid="held-total-unknown">
          <Caption>a total with one part not known</Caption>
          <span className="text-lg font-medium text-fg-2">Not known</span>
          <HeldMark state={total.state} asOf={total.asOf} />
        </div>
        <div className="flex flex-col gap-1" data-testid="held-total">
          <Caption>the total of the three parts with a figure, at the oldest time among them</Caption>
          <span className="if-num text-lg font-medium tabular-nums">1,750.00 USDC</span>
          <HeldMark state={totalKnown.state} asOf={totalKnown.asOf} asOfText={totalKnown.asOf ? asOfText(totalKnown.asOf) : undefined} />
        </div>
      </div>
    </div>
  );
}
