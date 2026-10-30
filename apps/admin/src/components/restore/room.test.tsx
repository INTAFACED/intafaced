import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RestoreRoom as Room } from '@/lib/restore/read';
import type { RunDetail } from '@/lib/restore/model';
import { RestoreRoom } from './room';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const failed = { kind: 'failed' as const, message: 'svc-ops is down', code: null, forbidden: false, notBuilt: false };
const run = { restoreNo: 'R-1', cutOff: '2026-10-20T12:00:00.000Z', startedBy: 'u1', startedAt: '2026-10-20T12:01:00.000Z' };

const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  run,
  steps: [{ restoreNo: 'R-1', step: 'restore_clean', actor: 'u1', approverId: null, at: '2026-10-20T12:02:00.000Z' }],
  restored: false,
  next: 'validate',
  finalizeOffered: false,
  live: {
    joint: {
      agree: false,
      cutOff: run.cutOff,
      services: [
        { service: 'ledger', ok: true, reason: null, stamp: '9', position: '9' },
        { service: 'identity', ok: false, reason: 'position_differs', stamp: '4', position: '5' },
        { service: 'bank', ok: false, reason: 'read_missing', stamp: '2', position: null },
        { service: 'pay', ok: false, reason: 'stamp_missing', stamp: null, position: '1' },
      ],
    },
    reads: [{ service: 'bank', ok: false, code: 'ops.restore_watermark_unavailable', message: 'timed out' }],
  },
  ...over,
});

const room = (over: Partial<Room> = {}): Room =>
  ({
    asOf: '2026-10-20T12:10:00.000Z',
    backups: { kind: 'ok', data: { reason: 'ops.restore_archive_unconfigured', backups: [] } },
    stamps: { kind: 'ok', data: { stamped: false, rows: [] } },
    runs: { kind: 'ok', data: [] },
    run: null,
    ...over,
  }) as Room;

describe('restore room', () => {
  it('says no backup, stamp or run exists, with the reason, and never a number', () => {
    const html = renderToStaticMarkup(<RestoreRoom room={room()} runNo={null} userId="u-1" />);
    expect(html).toContain('data-testid="backups-empty"');
    expect(html).toContain('No joint-restore archive is configured');
    expect(html).toContain('data-testid="stamps-empty"');
    expect(html).toContain('data-testid="runs-empty"');
    expect(html).toContain('data-testid="start-run"');
  });

  it('says an archive that could not be read lists no backup, and never says it is not probed', () => {
    const backups = { kind: 'ok', data: { reason: 'ops.restore_archive_unprobed', backups: [] } } as Room['backups'];
    const html = renderToStaticMarkup(<RestoreRoom room={room({ backups })} runNo={null} userId="u-1" />);
    expect(html).toContain('data-testid="backups-empty"');
    expect(html).toContain('An archive is configured but it could not be read, or did not answer with a backup list');
    expect(html).not.toContain('not probed');
    expect(html).not.toContain('does not probe');
  });

  it('shows a failed part as a failure, not as empty', () => {
    const html = renderToStaticMarkup(
      <RestoreRoom room={room({ runs: failed, stamps: failed, backups: failed })} runNo={null} userId="u-1" />,
    );
    expect(html).toContain('data-testid="runs-failed"');
    expect(html).toContain('data-testid="stamps-failed"');
    expect(html).toContain('data-testid="backups-failed"');
    expect(html).not.toContain('data-testid="runs-empty"');
  });

  it('names each disagreeing service and why, and offers only the next step', () => {
    const html = renderToStaticMarkup(<RestoreRoom room={room({ run: { kind: 'ok', data: detail() } })} runNo="R-1" userId="u-1" />);
    expect(html).toContain('The service reports a different position than its stamp.');
    expect(html).toContain('The service could not be read, so its position is unknown.');
    expect(html).toContain('No stamp has been recorded for this service.');
    expect(html).toContain('svc-bank could not be read');
    expect(html).toContain('data-testid="step-validate"');
    expect(html).not.toContain('data-testid="step-preview"');
    expect(html).not.toContain('data-testid="finalize-form"');
  });

  it('parks finalize with its blocker until svc-ops offers it, then shows the approval form', () => {
    const parked = renderToStaticMarkup(
      <RestoreRoom
        room={room({ run: { kind: 'ok', data: detail({ next: 'finalize', finalizeOffered: false }) } })}
        runNo="R-1"
        userId="u-1"
      />,
    );
    expect(parked).toContain('data-testid="finalize-parked"');
    expect(parked).not.toContain('data-testid="finalize-form"');
    const offered = renderToStaticMarkup(
      <RestoreRoom
        room={room({ run: { kind: 'ok', data: detail({ next: 'finalize', finalizeOffered: true }) } })}
        runNo="R-1"
        userId="u-1"
      />,
    );
    expect(offered).toContain('data-testid="finalize-form"');
  });

  it('names why restore writes are parked before the controls, which stay visible', () => {
    const writes = {
      title: 'Restore steps go out under the treasury credential, which is not yours',
      body: 'That is another founder on this console.',
      next: 'Ask the founder who holds the treasury credential to do this step.',
      code: 'admin.treasury_holder_mismatch',
      changed: 'no',
    } as const;
    const html = renderToStaticMarkup(<RestoreRoom room={room()} runNo={null} userId="u-1" writes={writes} />);
    expect(html).toContain('data-testid="restore-writes-parked"');
    expect(html).toContain('Code: admin.treasury_holder_mismatch');
    expect(html).toContain('data-testid="start-run"');
    expect(renderToStaticMarkup(<RestoreRoom room={room()} runNo={null} userId="u-1" />)).not.toContain('restore-writes-parked');
  });
});
