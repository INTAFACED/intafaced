import { EmptyState, Table, type TableColumn } from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import type { CopyPosition, RoomApi } from './api';
import { roomCopy } from './copy';
import type { Follow } from './FollowDetail';
import { InfoNote, RefusalNote } from './parts';

type VenueFillRow = NonNullable<CopyPosition['venue']>['fills'][number];

const STATE: Record<string, string> = {
  open: 'On the venue',
  resting: 'On the venue',
  partially_filled: 'On the venue',
  filled: 'Filled',
  cancelled: 'Cancelled',
  expired: 'Expired',
  rejected: 'Refused',
  unknown: 'Being checked',
  pending: 'Not sent',
};

/** The venue's own words for where its record of the copies comes from, with TEST on a test venue. */
function Source({ rows }: { rows: readonly CopyPosition[] }) {
  const { t } = roomCopy.useCopy();
  const on = rows.find((r) => r.venue)?.venue;
  if (!on) return null;
  return (
    <InfoNote>
      {t('Each copy is your own order on {venue}, placed by this follow’s agent permission, as {venue} reports it.', {
        venue: on.venueName,
      })}
      {on.test ? ' TEST' : ''}
    </InfoNote>
  );
}

/**
 * A venue follow's copies (J-copy-bots-otc-01 #8; svc-trade venue-copy.ts `copiedOrders`): each copy is the person's
 * own venue order on the follow's agent account, placed by its agent permission, read back from the venue.
 */
export function VenueCopiedOrders({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.followPositions(follow.followId, signal), `venue-copies:${follow.followId}`);
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  const rows = resource.status === 'ready' ? resource.data.positions : [];
  const columns: TableColumn<CopyPosition>[] = [
    { id: 'market', header: t('Market'), value: (r) => r.market, pin: 'start' },
    { id: 'side', header: t('Side'), value: (r) => (r.side === 'sell' ? t('Sell') : t('Buy')) },
    { id: 'qty', header: t('Amount'), value: (r) => r.qty, numeric: true, cell: (r) => displayAmount(r.qty) },
    { id: 'filled', header: t('Filled'), value: (r) => r.filledQty, numeric: true, cell: (r) => displayAmount(r.filledQty) },
    { id: 'price', header: t('Price'), value: (r) => r.price, numeric: true, cell: (r) => displayAmount(r.price) },
    { id: 'state', header: t('Venue status'), value: (r) => t((STATE[r.status] ?? 'Not known') as 'Filled') },
    {
      id: 'placedBy',
      header: t('Placed by'),
      value: (r) => r.venue?.placedBy ?? '',
      cell: (r) => <span data-testid="copy-placed-by">{r.venue?.placedBy ?? t('Not known')}</span>,
    },
  ];
  return (
    <>
      <Table
        label={t('Copied orders')}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.orderId}
        status={resource.status === 'loading' ? 'loading' : 'ready'}
        minWidth={760}
        emptyState={
          <EmptyState
            size="inline"
            title={t('No copied orders')}
            reason={t('A copy appears here when the leader trades and automatic copying is on.')}
          />
        }
      />
      <Source rows={rows} />
    </>
  );
}

/** The fills of a venue follow's copies, each with the venue's fee and our builder fee as the venue charged them. */
export function VenueCopiedFills({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.followPositions(follow.followId, signal), `venue-fills:${follow.followId}`);
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  const copies = resource.status === 'ready' ? resource.data.positions : [];
  const rows = copies.flatMap((o) => (o.venue?.fills ?? []).map((f) => ({ ...f, market: o.market, side: o.side })));
  const columns: TableColumn<VenueFillRow & { market: string; side: 'buy' | 'sell' }>[] = [
    { id: 'market', header: t('Market'), value: (r) => r.market, pin: 'start' },
    { id: 'side', header: t('Side'), value: (r) => (r.side === 'sell' ? t('Sell') : t('Buy')) },
    { id: 'amount', header: t('Amount'), value: (r) => r.amount, numeric: true, cell: (r) => displayAmount(r.amount) },
    { id: 'price', header: t('Price'), value: (r) => r.price, numeric: true, cell: (r) => displayAmount(r.price) },
    {
      id: 'venueFee',
      header: t('Venue fee'),
      value: (r) => r.venueFee,
      numeric: true,
      cell: (r) => `${displayAmount(r.venueFee)} ${r.feeAsset}`,
    },
    {
      id: 'builderFee',
      header: t('Our builder fee'),
      value: (r) => r.builderFee,
      numeric: true,
      cell: (r) => `${displayAmount(r.builderFee)} ${r.feeAsset}`,
    },
    { id: 'at', header: t('Filled at'), value: (r) => new Date(r.filledAt).toLocaleString(), width: 200 },
  ];
  return (
    <>
      <Table
        label={t('Copied fills')}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.fillId}
        status={resource.status === 'loading' ? 'loading' : 'ready'}
        minWidth={760}
        emptyState={
          <EmptyState size="inline" title={t('No copied fills')} reason={t('A fill appears here when a copy fills on the venue.')} />
        }
      />
      <Source rows={copies} />
      <InfoNote>{t('Leaders are paid a share of our fee only, never of your profit.')}</InfoNote>
    </>
  );
}
