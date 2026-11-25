import { useMemo } from 'react';
import { Figure, TileRow } from '@intafaced/ui/lit';
import { Shares } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../shared/money';
import { fmtPct } from './deps';
import { Shown, usdParts } from './money-parts';
import type { Standing } from './standing';
import type { VenueRead } from './standing-data';
import type { WalletRead } from './where-it-sits';
import { tilesOf, type LockedPart, type Tile } from './where-tiles';
import type { whereCopy } from './where-it-sits-copy';
import type { DepositsRead } from './WhereSide';

type T = ReturnType<typeof whereCopy.useCopy>['t'];
type Polled<D> = { data: D | null; failure: { message?: string } | null };

const LOCKED_WORD = {
  'in-orders': 'Tile locked in-orders',
  collateral: 'Tile locked collateral',
  stake: 'Tile locked stake',
  delegated: 'Tile locked delegated',
  unstaking: 'Tile locked unstaking',
  locked: 'Tile locked locked',
} as const satisfies Record<LockedPart['kind'], string>;

/** "a, b and c". */
function joined(items: readonly string[], t: T): string {
  if (items.length <= 1) return items[0] ?? '';
  return t('Total line and', { a: items.slice(0, -1).join(', '), b: items[items.length - 1] ?? '' });
}

/**
 * The three tiles across Assets (the owner's Money target, 25 Nov): withdrawable now, locked, and moving into the venue,
 * each a figure and one sentence, over one bar of their shares. Each figure is worked out from what the page already
 * reads (`where-tiles.ts`), at the prices the total uses; a source not read says so in words, never as zero.
 */
export function WhereTiles({
  standing,
  venue,
  wallet,
  deposits,
  hidden,
  t,
}: {
  standing: Standing;
  venue: Polled<VenueRead>;
  wallet: Polled<WalletRead>;
  deposits: DepositsRead;
  hidden: boolean;
  t: T;
}) {
  const tiles = useMemo(() => {
    const prices = new Map<string, string>();
    for (const part of standing.parts) for (const row of part.rows) if (row.priceUsd !== null) prices.set(row.asset, row.priceUsd);
    return tilesOf({
      venue: venue.data?.rows ?? null,
      wallet: wallet.data?.ok ? wallet.data.rows.map((row) => ({ asset: row.symbol, amount: row.amount })) : null,
      moving:
        deposits.status === 'ready'
          ? deposits.data.value.filter((d) => d.status === 'confirming').map((d) => ({ asset: d.asset, amount: d.amount }))
          : null,
      priceOf: (asset) => prices.get(asset) ?? null,
    });
  }, [standing, venue.data, wallet.data, deposits]);

  const reading = {
    withdrawable: (!venue.data && !venue.failure) || (!wallet.data && !wallet.failure),
    locked: !venue.data && !venue.failure,
    moving: deposits.status === 'loading',
  };
  const free = [
    ...new Set([
      ...(wallet.data?.ok ? wallet.data.rows.filter((r) => /[1-9]/.test(r.amount)).map((r) => r.symbol) : []),
      ...(venue.data?.rows ?? []).filter((r) => /[1-9]/.test(r.withdrawable)).map((r) => r.asset),
    ]),
  ];
  const moving = deposits.status === 'ready' ? deposits.data.value.filter((d) => d.status === 'confirming') : [];
  const sentence = {
    withdrawable: [
      tiles.withdrawable.any ? t('Tile withdrawable sentence', { assets: joined(free, t) }) : t('Tile withdrawable none'),
      ...(tiles.withdrawable.missing ?? []).map((source) => t(source === 'wallet' ? 'Tile missing wallet' : 'Tile missing venue')),
    ].join(' '),
    locked:
      tiles.lockedParts.length > 0
        ? `${joined(
            tiles.lockedParts.map((p) => t(LOCKED_WORD[p.kind], { amount: displayAmount(p.amount), asset: p.asset })),
            t,
          )}.`
        : t('Tile locked none'),
    moving: tiles.moving.any
      ? t('Tile moving sentence', {
          amounts: joined(
            moving.map((d) => `${displayAmount(d.amount)} ${d.asset}`),
            t,
          ),
        })
      : t('Tile moving none'),
  };
  const shares = tiles.shares
    ? (['withdrawable', 'locked', 'moving'] as const).flatMap((key) => {
        const share = tiles.shares?.[key] ?? null;
        return share === null ? [] : [{ key, label: t(TILE_TITLE[key]), share, text: fmtPct(share, { signed: false }) }];
      })
    : [];
  return (
    <section className="lt-stack money-where__tiles" aria-label={t('Tiles label')} data-testid="assets-tiles">
      <TileRow min="wide">
        {(['withdrawable', 'locked', 'moving'] as const).map((key, index) => (
          <TileFace
            key={key}
            id={key}
            index={index}
            tile={tiles[key]}
            reading={reading[key]}
            sentence={sentence[key]}
            hidden={hidden}
            t={t}
          />
        ))}
      </TileRow>
      {shares.length > 1 ? (
        <div className="money-where__tiles-bar">
          <Shares label={t('Tiles label')} shares={shares} />
        </div>
      ) : null}
    </section>
  );
}

const TILE_TITLE = { withdrawable: 'Tile withdrawable', locked: 'Tile locked', moving: 'Tile moving' } as const;
const NOT_KNOWN = {
  withdrawable: 'Tile not known withdrawable',
  locked: 'Tile not known locked',
  moving: 'Tile not known moving',
} as const;

function TileFace({
  id,
  index,
  tile,
  reading,
  sentence,
  hidden,
  t,
}: {
  id: keyof typeof TILE_TITLE;
  index: number;
  tile: Tile;
  reading: boolean;
  sentence: string;
  hidden: boolean;
  t: T;
}) {
  return (
    <div className="lt-stack lt-stack-tight" data-testid="assets-tile" data-tile={id} data-value-usd={tile.valueUsd ?? ''}>
      <span className="lt-row lt-row-nowrap lt-hint">
        <span className="lt-parts-swatch" data-part={index} aria-hidden="true" />
        <span>{t(TILE_TITLE[id])}</span>
      </span>
      {reading || !tile.known ? (
        // A source still on its way draws no partial figure: the tile waits for every source it adds up.
        <p className="lt-hint">{reading ? t('Tile reading') : t(NOT_KNOWN[id])}</p>
      ) : (
        <>
          {tile.valueUsd === null ? (
            <p className="lt-hint">{t('Tile no price')}</p>
          ) : hidden ? (
            <Shown text={null} hidden />
          ) : (
            <Figure parts={usdParts(tile.valueUsd)} size="figure" />
          )}
          <p className="lt-hint">
            {sentence}
            {tile.unpriced.length > 0 && tile.valueUsd !== null ? ` ${t('Tile unpriced', { assets: tile.unpriced.join(', ') })}` : null}
          </p>
        </>
      )}
    </div>
  );
}
