import { EmptyState, Table, type TableColumn } from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import type { RoomApi, VenueCopiedOrder } from './api';
import { roomCopy } from './copy';
import type { Follow } from './FollowDetail';
import { InfoNote, RefusalNote } from './parts';

type VenueFillRow = VenueCopiedOrder['fills'][number];

const STATE: Record<VenueCopiedOrder['state'], string> = {
  accepted: 'On the venue',
  unknown: 'Being checked',
  refused: 'Refused',
  not_sent: 'Not sent',
};

/**
 * A follow's copies on the person's own venue account (J-copy-bots-otc-01 #8): each copy is the person's own venue
 * order, placed by the follow's permission, read back from the venue. Every figure is the venue's own report.
 */
export function VenueCopiedOrders({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.venueCopiedOrders(follow.followId, signal), `venue-copies:${follow.followId}`);
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  const rows = resource.status === 'ready' ? resource.data.orders : [];
  const columns: TableColumn<VenueCopiedOrder>[] = [
    { id: 'market', header: t('Market'), value: (r) => r.order?.symbol ?? '', pin: 'start' },
    { id: 'side', header: t('Side'), value: (r) => (r.order?.side === 'sell' ? t('Sell') : t('Buy')) },
    {
      id: 'qty',
      header: t('Amount'),
      value: (r) => r.order?.amount ?? '',
      numeric: true,
      cell: (r) => (r.order ? displayAmount(r.order.amount) : ''),
    },
    {
      id: 'filled',
      header: t('Filled'),
      value: (r) => r.order?.filled ?? '',
      numeric: true,
      cell: (r) => (r.order ? displayAmount(r.order.filled) : ''),
    },
    {
      id: 'price',
      header: t('Price'),
      value: (r) => r.order?.price ?? '',
      numeric: true,
      cell: (r) => (r.order ? displayAmount(r.order.price) : ''),
    },
    { id: 'state', header: t('State'), value: (r) => t(STATE[r.state] as 'Refused') },
    { id: 'venueStatus', header: t('Venue status'), value: (r) => r.order?.status ?? t('Not known') },
    {
      id: 'signedBy',
      header: t('Placed by'),
      value: (r) => r.signedBy,
      cell: (r) => <span data-testid="copy-signed-by">{r.signedBy}</span>,
    },
  ];
  return (
    <>
      <Table
        label={t('Copied orders')}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.actionKey}
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
      {resource.status === 'ready' ? (
        <InfoNote>
          {t('Each copy is your own order on {venue}, placed by this follow’s permission, as {venue} reports it.', {
            venue: resource.data.venueName,
          })}
          {resource.data.test ? ` ${t('TEST')}` : ''}
        </InfoNote>
      ) : null}
    </>
  );
}

/** The fills of a follow's copies, each with the venue's fee and our builder fee as the venue charged them. */
export function VenueCopiedFills({ follow, api }: { follow: Follow; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const { resource, reload } = useResource((signal) => api.venueCopiedOrders(follow.followId, signal), `venue-fills:${follow.followId}`);
  if (resource.status === 'failed') return <RefusalNote failure={resource.failure} retry={reload} />;
  const rows = resource.status === 'ready' ? resource.data.orders.flatMap((o) => o.fills) : [];
  const columns: TableColumn<VenueFillRow>[] = [
    { id: 'market', header: t('Market'), value: (r) => r.symbol, pin: 'start' },
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
      <InfoNote>{t('Leaders are paid a share of our fee only, never of your profit.')}</InfoNote>
    </>
  );
}
