import { Fragment, useState } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { displayAmount } from '../../../shared/money';
import type { Resource } from '../../../shared/resource';
import { Panel, ReportedTime } from './deposit-parts';
import { DepositTravelRulePanel } from './DepositTravelRule';
import { depositRecordsCopy } from '../deposit-records-copy';
import {
  DEPOSIT_RECORDS_PAGE,
  DEPOSIT_STATUSES,
  useDepositPending,
  useDepositRecords,
  type DepositPending,
  type DepositRecordFilters,
  type DepositRecordView,
  type DepositStatus,
} from '../deposit-reads';

const UNSET = 'bank.deposit_custody_unset';

/** Deposits seen on the network and not yet credited, each with its confirmation counter. Custody off is named, never an empty list. */
export function DepositPendingPanel() {
  const pending = useDepositPending();
  return <DepositPendingView resource={pending.resource} reload={pending.reload} />;
}

export function DepositPendingView({ resource, reload }: { resource: Resource<DepositPending>; reload: () => void }) {
  const { t } = depositRecordsCopy.useCopy();
  return (
    <Panel title={t('pendingTitle')} lead={t('pendingLead')}>
      {resource.status === 'loading' ? (
        <p className="lt-hint" role="status">
          …
        </p>
      ) : resource.status === 'failed' ? (
        resource.failure.code === UNSET ? (
          <p className="lt-hint" role="status">
            {t('pendingUnavailable')}
          </p>
        ) : (
          <EmptyState
            title={t('recordsFailed')}
            action={
              <Button tone="secondary" onClick={reload}>
                {t('pendingRetry')}
              </Button>
            }
          />
        )
      ) : resource.data.items.length === 0 ? (
        <p className="lt-hint">{t('pendingEmpty')}</p>
      ) : (
        <ul data-testid="deposit-pending">
          {resource.data.items.map((row) => (
            <li key={row.id}>
              <strong className="lt-mono">
                {displayAmount(row.amount)} {row.assetId}
              </strong>{' '}
              <span className="lt-hint">{row.networkId}</span>
              <br />
              <progress
                max={row.confirmationsRequired ?? undefined}
                value={row.confirmationsRequired === null ? undefined : Math.min(row.confirmations, row.confirmationsRequired)}
              />{' '}
              <span className="lt-hint">
                {row.confirmationsRequired === null
                  ? t('progressNoTarget', { done: row.confirmations })
                  : t('progress', { done: Math.min(row.confirmations, row.confirmationsRequired), need: row.confirmationsRequired })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function DepositRecordsPanel({ assets }: { assets: readonly string[] }) {
  const [filters, setFilters] = useState<DepositRecordFilters>({});
  const [limit, setLimit] = useState(DEPOSIT_RECORDS_PAGE);
  const records = useDepositRecords(filters, limit);
  const change = (next: DepositRecordFilters) => {
    setFilters(next);
    setLimit(DEPOSIT_RECORDS_PAGE);
  };
  return (
    <DepositRecordsView
      resource={records.resource}
      reload={records.reload}
      filters={filters}
      onFilters={change}
      assets={assets}
      onMore={() => setLimit(limit + DEPOSIT_RECORDS_PAGE)}
    />
  );
}

export function DepositRecordsView({
  resource,
  reload,
  filters,
  onFilters,
  assets,
  onMore,
}: {
  resource: Resource<{ items: DepositRecordView[]; total: number }>;
  reload: () => void;
  filters: DepositRecordFilters;
  onFilters: (next: DepositRecordFilters) => void;
  assets: readonly string[];
  onMore: () => void;
}) {
  const { t } = depositRecordsCopy.useCopy();
  const text = (key: 'txId' | 'address') => (value: string) => onFilters({ ...filters, [key]: value.trim() || undefined });
  return (
    <Panel title={t('recordsTitle')} lead={t('recordsLead')}>
      <div className="lt-toolbar">
        <label className="lt-field">
          <span>{t('filterAsset')}</span>
          <select value={filters.assetId ?? ''} onChange={(event) => onFilters({ ...filters, assetId: event.target.value || undefined })}>
            <option value="">{t('filterAny')}</option>
            {assets.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="lt-field">
          <span>{t('filterStatus')}</span>
          <select
            value={filters.status ?? ''}
            onChange={(event) => onFilters({ ...filters, status: (event.target.value || undefined) as DepositStatus | undefined })}
          >
            <option value="">{t('filterAny')}</option>
            {DEPOSIT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`status_${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="lt-field">
          <span>{t('filterTx')}</span>
          <input defaultValue={filters.txId ?? ''} onBlur={(event) => text('txId')(event.target.value)} />
        </label>
        <label className="lt-field">
          <span>{t('filterAddress')}</span>
          <input defaultValue={filters.address ?? ''} onBlur={(event) => text('address')(event.target.value)} />
        </label>
      </div>
      {resource.status === 'loading' ? (
        <p className="lt-hint" role="status">
          …
        </p>
      ) : resource.status === 'failed' ? (
        resource.failure.code === UNSET ? (
          <p className="lt-hint" role="status">
            {t('recordsUnavailable')}
          </p>
        ) : (
          <EmptyState
            title={t('recordsFailed')}
            action={
              <Button tone="secondary" onClick={reload}>
                {t('pendingRetry')}
              </Button>
            }
          />
        )
      ) : resource.data.items.length === 0 ? (
        <EmptyState title={t('recordsEmpty')} />
      ) : (
        <>
          <table className="lt-table" data-testid="deposit-records">
            <thead>
              <tr>
                <th scope="col">{t('colWhen')}</th>
                <th scope="col">{t('colAmount')}</th>
                <th scope="col">{t('colTx')}</th>
                <th scope="col">{t('colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.items.map((row) => (
                <Fragment key={row.id}>
                  <tr>
                    <td>
                      <ReportedTime value={row.detectedAt} />
                    </td>
                    <td className="lt-mono">
                      {displayAmount(row.amount)} {row.assetId}
                    </td>
                    <td className="lt-mono">{row.txHash}</td>
                    <td>
                      <span data-status={row.status}>{t(`status_${row.status}`)}</span>
                      {row.reason && (
                        <small role="note">
                          {' '}
                          {t(`reason_${row.reason}`, { minimum: displayAmount(row.minimumDeposit ?? '0'), asset: row.assetId })}
                        </small>
                      )}
                      {!row.reason && (row.status === 'detected' || row.status === 'confirming') && (
                        <small>
                          {' '}
                          {row.confirmationsRequired === null
                            ? t('progressNoTarget', { done: row.confirmations })
                            : t('progress', {
                                done: Math.min(row.confirmations, row.confirmationsRequired),
                                need: row.confirmationsRequired,
                              })}
                        </small>
                      )}
                    </td>
                  </tr>
                  {row.status === 'held_travel_rule' && (
                    <tr>
                      <td colSpan={4}>
                        <DepositTravelRulePanel depositId={row.id} onChanged={reload} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="lt-hint">{t('recordsShown', { shown: resource.data.items.length, total: resource.data.total })}</p>
          {resource.data.items.length < resource.data.total && (
            <Button tone="secondary" onClick={onMore}>
              {t('recordsMore')}
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}
