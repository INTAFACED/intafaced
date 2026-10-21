import { describe, expect, it } from 'vitest';
import { jointWatermark, nextRestoreStep, restoreWatermarkReadSchema, type RestoreWatermarkRead } from './ops-restore-watermarks.js';

const cutOff = '2026-10-20T12:00:00.000Z';
const read = (
  service: RestoreWatermarkRead['service'],
  position: string,
  lastWriteAt: string | null = '2026-10-20T11:00:00.000Z',
): RestoreWatermarkRead => ({
  service,
  kind: 'seq',
  position,
  integrity: null,
  lastWriteAt,
  readAt: '2026-10-20T12:01:00.000Z',
});
const stamps = [
  { service: 'ledger', watermark: '10' },
  { service: 'identity', watermark: '7' },
  { service: 'bank', watermark: '3' },
  { service: 'pay', watermark: '99' },
];
const reads = [read('ledger', '10'), read('identity', '7'), read('bank', '3'), read('pay', '99')];

describe('jointWatermark', () => {
  it('agrees when each service matches its own stamp, though the sequences differ', () => {
    expect(jointWatermark({ cutOff, stamps, reads }).agree).toBe(true);
  });
  it('names a missing stamp', () => {
    const r = jointWatermark({ cutOff, stamps: stamps.slice(1), reads });
    expect(r.agree).toBe(false);
    expect(r.services[0]).toMatchObject({ service: 'ledger', reason: 'stamp_missing' });
  });
  it('names a service whose read is missing', () => {
    expect(jointWatermark({ cutOff, stamps, reads: reads.slice(0, 3) }).services[3]?.reason).toBe('read_missing');
  });
  it('names a differing position', () => {
    const r = jointWatermark({ cutOff, stamps, reads: [read('ledger', '11'), ...reads.slice(1)] });
    expect(r.services[0]).toMatchObject({ ok: false, reason: 'position_differs', stamp: '10', position: '11' });
  });
  it('refuses a write after the cut-off and takes the newest stamp per service', () => {
    const late = [read('ledger', '12', '2026-10-20T12:00:00.001Z'), ...reads.slice(1)];
    const r = jointWatermark({
      cutOff,
      stamps: [{ service: 'ledger', watermark: '10' }, ...stamps.slice(1), { service: 'ledger', watermark: '12' }],
      reads: late,
    });
    expect(r.services[0]?.reason).toBe('written_after_cutoff');
  });
  it('treats a write exactly at the cut-off as before it, and a never-written service as quiet', () => {
    const r = jointWatermark({ cutOff, stamps, reads: [read('ledger', '10', cutOff), read('identity', '7', null), ...reads.slice(2)] });
    expect(r.agree).toBe(true);
  });
  it('fails closed on an unparseable cut-off', () => {
    const r = jointWatermark({ cutOff: 'nope', stamps, reads: reads.map((x) => ({ ...x, lastWriteAt: null })) });
    expect(r.agree).toBe(false);
    expect(r.services[0]?.reason).toBe('cutoff_invalid');
  });
});

describe('nextRestoreStep', () => {
  it('walks the steps in order', () => {
    expect(nextRestoreStep([])).toBe('restore_clean');
    expect(nextRestoreStep(['restore_clean', 'validate'])).toBe('preview');
    expect(nextRestoreStep(['restore_clean', 'validate', 'preview', 'finalize'])).toBeNull();
  });
  it('refuses a record that skipped a step', () => {
    expect(nextRestoreStep(['validate'])).toBeNull();
  });
});

describe('restoreWatermarkReadSchema', () => {
  it('takes a decimal-string position only', () => {
    expect(restoreWatermarkReadSchema.safeParse(read('bank', '5')).success).toBe(true);
    expect(restoreWatermarkReadSchema.safeParse({ ...read('bank', '5'), position: 5 }).success).toBe(false);
    expect(restoreWatermarkReadSchema.safeParse({ ...read('bank', '5'), position: '5.5' }).success).toBe(false);
  });
});
