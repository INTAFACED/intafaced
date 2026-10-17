import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { parsePortalRoute } from '../../routes';
import type { SettingsBApi } from '../b-client';
import { Covers, JobActions, JobChip, RequestForm } from './Exports';
import { ReportsView } from './Reports';
import {
  canDelete,
  columnLabel,
  columnsFor,
  formatBytes,
  hasDateRange,
  isBuilding,
  kindColumns,
  rangeParts,
  statusesFor,
  statusWord,
  windowOf,
  windowProblem,
} from './model';
import { exportKinds, type ExportJob } from './schemas';

// TEST DATA only.
const api = {} as unknown as SettingsBApi;
const job = (patch: Partial<ExportJob> = {}): ExportJob => ({
  jobId: 'f1000000-0000-4000-8000-000000000001',
  kind: 'payments',
  filters: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', status: 'captured' },
  columns: ['payment_id'],
  status: 'ready',
  failureCode: null,
  fileName: 'payments.csv',
  sizeBytes: '20480',
  rowCount: 120,
  sha256: 'a'.repeat(64),
  requestedBy: 'owner-1',
  asOf: '2026-10-15T08:00:00.000Z',
  generatedAt: '2026-10-15T09:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-10-15T08:59:00.000Z',
  completedAt: '2026-10-15T09:00:05.000Z',
  ...patch,
});

describe('report catalog', () => {
  const out = renderToString(<ReportsView jobs={[job(), job({ jobId: 'j2', kind: 'fees', filters: {} })]} hasMore={false} role="owner" />);
  it('lists every supported kind with its contents and column count', () => {
    for (const word of ['Payments', 'Settlements', 'Payouts', 'Refunds', 'Balances', 'Disputes', 'Fees']) expect(out).toContain(word);
    expect(out).toContain('11 columns');
    expect(out).toContain('only your own account');
  });
  it('shows when you last made one, with its range, made-at and as-of times', () => {
    expect(out).toContain('Made');
    expect(out).toContain('Figures as of');
    expect(out).toContain('Oct 1, 2026 to Oct 7, 2026');
  });
  it('says none yet for a kind never requested, and never invents a date', () => {
    expect(out).toContain('None yet');
  });
  it('says the newest files may not hold a kind, when more exist', () => {
    expect(renderToString(<ReportsView jobs={[]} hasMore role="owner" />)).toContain('Not in your newest files');
  });
  it('opens the request form with the kind chosen', () => {
    for (const kind of exportKinds) expect(out).toContain(`/pay/reports/exports?report=${kind}#request`);
  });
  it('has no coming-soon wording', () => {
    expect(out).not.toMatch(/coming soon/i);
  });
});

describe('report columns and filters', () => {
  it('hides the pricing level from viewers and developers only, and only on fees', () => {
    expect(columnsFor('fees', 'viewer')).not.toContain('applied_layer');
    expect(columnsFor('fees', 'developer')).not.toContain('fee_bps');
    expect(columnsFor('fees', 'finance')).toContain('applied_layer');
    expect(columnsFor('payments', 'viewer')).toEqual(kindColumns.payments);
  });
  it('offers a status filter only where the service accepts one', () => {
    expect(statusesFor('payments')).toContain('captured');
    expect(statusesFor('settlements')).toContain('paid_out');
    expect(statusesFor('disputes')).toContain('won');
    expect(statusesFor('fees')).toBeNull();
    expect(statusesFor('refunds')).toBeNull();
    expect(statusesFor('ledger_statement')).toBeNull();
  });
  it('gives balances no date range', () => {
    expect(hasDateRange('ledger_statement')).toBe(false);
    expect(hasDateRange('payments')).toBe(true);
  });
  it('turns the last picked day into an exclusive end, and reads it back as that day', () => {
    const w = windowOf('2026-10-01', '2026-10-07');
    expect(w).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' });
    expect(rangeParts({ filters: w })).toMatchObject({ from: '2026-10-01', to: '2026-10-07' });
    expect(windowProblem('2026-10-08', '2026-10-07')).toBe(true);
    expect(windowProblem('2026-10-07', '2026-10-07')).toBe(false);
  });
  it('writes column names in words', () => {
    expect(columnLabel('payment_id')).toBe('Payment ID');
    expect(columnLabel('fee_bps')).toBe('Fee rate');
    expect(columnLabel('created_at')).toBe('Created at');
  });
  it('formats sizes and survives a missing one', () => {
    expect(formatBytes('512')).toBe('512 B');
    expect(formatBytes('20480')).toBe('20.0 KB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });
  it('can delete everything except a file being built right now or one already deleted', () => {
    expect(['queued', 'ready', 'failed'].every((status) => canDelete({ status: status as ExportJob['status'] }))).toBe(true);
    expect(canDelete({ status: 'running' })).toBe(false);
    expect(canDelete({ status: 'expired' })).toBe(false);
    expect(isBuilding({ status: 'queued' })).toBe(true);
  });
});

describe('request form', () => {
  it('opens on the kind the address asks for, with every column ticked', () => {
    const out = renderToString(<RequestForm api={api} role="owner" onRequested={() => {}} initialKind="refunds" />);
    expect(out).toContain('Every refund, with its payment and amount.');
    expect(out).toContain('Payment ID');
    expect(out).toContain('Request a report');
  });
  it('offers a status filter for payments but not for fees', () => {
    expect(renderToString(<RequestForm api={api} role="owner" onRequested={() => {}} initialKind="payments" />)).toContain('captured');
    expect(renderToString(<RequestForm api={api} role="owner" onRequested={() => {}} initialKind="fees" />)).not.toContain('>captured<');
  });
  it('tells a viewer why the pricing level is missing', () => {
    expect(renderToString(<RequestForm api={api} role="viewer" onRequested={() => {}} initialKind="fees" />)).toContain(
      'not the pricing level',
    );
  });
  it('shows no date range for balances', () => {
    expect(renderToString(<RequestForm api={api} role="owner" onRequested={() => {}} initialKind="ledger_statement" />)).toContain(
      'has no date range',
    );
  });
});

describe('files', () => {
  it('names every status in words', () => {
    for (const [status, word] of [
      ['queued', 'Waiting'],
      ['running', 'Building'],
      ['ready', 'Ready'],
      ['failed', 'Failed'],
      ['expired', 'Deleted'],
    ] as const)
      expect(renderToString(<JobChip status={status} />)).toContain(word);
  });
  it('offers Download for a ready file and Delete file with a confirm, but not Download for a failed one', () => {
    const ready = renderToString(<JobActions api={api} job={job()} onDone={() => {}} />);
    expect(ready).toContain('Download');
    expect(ready).toContain('Delete file');
    const failed = renderToString(<JobActions api={api} job={job({ status: 'failed' })} onDone={() => {}} />);
    expect(failed).not.toContain('>Download<');
    expect(failed).toContain('Delete file');
    const running = renderToString(<JobActions api={api} job={job({ status: 'running' })} onDone={() => {}} />);
    expect(running).not.toContain('Delete file');
    expect(renderToString(<JobActions api={api} job={job({ status: 'expired' })} onDone={() => {}} />)).not.toContain('Delete file');
  });
  it('says what a file covers, including balances at the time it was made', () => {
    expect(renderToString(<Covers job={job()} />)).toContain('Oct 1, 2026 to Oct 7, 2026');
    expect(renderToString(<Covers job={job({ kind: 'ledger_statement', filters: {} })} />)).toContain('Balances when the file was made');
    expect(renderToString(<Covers job={job({ filters: {} })} />)).toContain('All dates');
  });
  it('writes a status as a word, never as the raw value', () => {
    // the sample file filters on the status "captured", which the payments pages call Paid
    const out = renderToString(<Covers job={job()} />);
    expect(out).toContain('Paid');
    expect(out).not.toContain('captured');
    expect(statusWord('settlements', 'paid_out')).toBe('Paid out');
    expect(statusWord('disputes', 'won')).toBe('Won');
    expect(statusWord('payments', 'brand_new_status')).toBe('Brand new status');
  });
});

describe('addresses', () => {
  it('routes the catalog and the files page', () => {
    expect(parsePortalRoute('/pay/reports')?.room).toBe('reports');
    expect(parsePortalRoute('/pay/reports/exports')?.room).toBe('report-exports');
  });
});
