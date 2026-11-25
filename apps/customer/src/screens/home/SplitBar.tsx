import { useMemo } from 'react';
import { HIDDEN_MASK } from '@intafaced/ui/lit';
import { Parts, sumDecimals } from '@intafaced/ui/lit/templates';
import { commandCopy } from './command-copy';
import { compareDecimal, fmtUsd, type HomePortfolio } from './deps';
import type { useHomeStanding } from './HomeStanding';

type Standing = NonNullable<ReturnType<typeof useHomeStanding>>;
type SplitId = 'cash' | 'crypto' | 'trading' | 'earn' | 'web3';
const ORDER: readonly SplitId[] = ['cash', 'crypto', 'trading', 'earn', 'web3'];
const LABEL = {
  cash: 'Split Cash',
  crypto: 'Split Crypto',
  trading: 'Split Trading',
  earn: 'Split Earn',
  web3: 'Split Web3',
} as const satisfies Record<SplitId, string>;

/** One part of the split: its dollar value as its source reports it, or null when Home does not read it (never zero). */
export type Split = Record<SplitId, string | null>;

/**
 * The launch model's split (the owner's Home A): Cash is the partner account, Crypto the person's own wallet, Trading
 * the venue account, each the same valued figure the total adds. Earn and Web3 have no read on Home, so they stay null.
 * A part that could not be read is null too.
 */
export function standingSplit(standing: Standing): Split {
  const of = (id: 'partner' | 'wallet' | 'venue') => {
    const part = standing.parts.find((p) => p.id === id);
    // No such source for this person (no partner account): it holds nothing, which is known, not unread.
    if (!part) return '0';
    if (part.state !== 'read') return null;
    return part.valueUsd ?? (part.rows.length === 0 ? '0' : null);
  };
  return { cash: of('partner'), crypto: of('wallet'), trading: of('venue'), earn: null, web3: null };
}

/** The bank's own total (the user-venue door off): its cash and its coins; the rest is not read on Home. */
export function ledgerSplit(data: HomePortfolio): Split {
  return { cash: data.cashUsd ?? null, crypto: data.cryptoUsd ?? null, trading: null, earn: null, web3: null };
}

/**
 * The thin split bar under the chart: five parts, each with its amount in the legend. Only parts Home reads are drawn;
 * a part it does not read says "not read" in the legend and adds nothing.
 */
export function SplitBar({ split, hidden, launch }: { split: Split; hidden: boolean; launch: boolean }) {
  const { t } = commandCopy.useCopy();
  const drawn = useMemo(
    () =>
      ORDER.flatMap((id) => {
        const value = split[id];
        return value !== null && (compareDecimal(value, '0') ?? 0) > 0 ? [{ id, label: t(LABEL[id]), value }] : [];
      }),
    [split, t],
  );
  const rest = ORDER.filter((id) => !drawn.some((part) => part.id === id));
  return (
    <div data-testid="home-split" className="hm-split" title={t(launch ? 'Split note' : 'Split note ledger')}>
      {drawn.length > 0 ? (
        <Parts
          label={t('Split label')}
          total={sumDecimals(drawn.map((part) => part.value))}
          parts={drawn.map(({ label, value }) => ({ label, value }))}
          asset="USD"
          hidden={hidden}
          legend="row"
        />
      ) : null}
      {rest.length > 0 ? (
        <ul className="hm-split-rest" aria-label={t('Split label')}>
          {rest.map((id) => (
            <li key={id} data-split={id} data-read={split[id] !== null}>
              <span>{t(LABEL[id])}</span>{' '}
              <span className="hm-split-value">{split[id] === null ? t('Split not read') : hidden ? HIDDEN_MASK : fmtUsd(split[id])}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
