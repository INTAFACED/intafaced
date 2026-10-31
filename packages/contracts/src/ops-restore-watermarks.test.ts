import { describe, expect, it } from 'vitest';
import {
  jointWatermark,
  jointWatermarkAsOf,
  nextRestoreStep,
  restoreWatermarkReadInputSchema,
  restoreWatermarkReadSchema,
  type RestoreWatermarkRead,
} from './ops-restore-watermarks.js';

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

describe('jointWatermarkAsOf', () => {
  const asOf = (r: RestoreWatermarkRead, at: string | null = cutOff): RestoreWatermarkRead => ({
    ...r,
    ...(at === null ? {} : { asOf: at }),
  });
  const asOfReads = reads.map((r) => asOf(r));

  it('agrees when each service read as of the cut-off matches its stamp, though it wrote after the cut-off', () => {
    const later = asOfReads.map((r) => ({ ...r, lastWriteAt: '2026-10-20T13:00:00.000Z' }));
    expect(jointWatermarkAsOf({ cutOff, stamps, reads: later }).agree).toBe(true);
  });
  it('the same instant in another offset is the cut-off', () => {
    const shifted = asOfReads.map((r) => ({ ...r, asOf: '2026-10-20T14:00:00.000+02:00' }));
    expect(jointWatermarkAsOf({ cutOff, stamps, reads: shifted }).agree).toBe(true);
  });
  it('a live read, or one as of another instant, says nothing about the cut-off', () => {
    const live = jointWatermarkAsOf({ cutOff, stamps, reads: [asOf(reads[0]!, null), ...asOfReads.slice(1)] });
    expect(live.services[0]).toMatchObject({ service: 'ledger', ok: false, reason: 'read_not_as_of' });
    const other = jointWatermarkAsOf({ cutOff, stamps, reads: [asOf(reads[0]!, '2026-10-20T12:00:01.000Z'), ...asOfReads.slice(1)] });
    expect(other.agree).toBe(false);
    expect(other.services[0]?.reason).toBe('read_not_as_of');
  });
  it('names a differing position, a missing stamp, a missing read and a bad cut-off', () => {
    const differs = jointWatermarkAsOf({ cutOff, stamps, reads: [asOf(read('ledger', '11')), ...asOfReads.slice(1)] });
    expect(differs.services[0]).toMatchObject({ reason: 'position_differs', stamp: '10', position: '11' });
    expect(jointWatermarkAsOf({ cutOff, stamps: stamps.slice(1), reads: asOfReads }).services[0]?.reason).toBe('stamp_missing');
    expect(jointWatermarkAsOf({ cutOff, stamps, reads: asOfReads.slice(1) }).services[0]?.reason).toBe('read_missing');
    expect(jointWatermarkAsOf({ cutOff: 'soon', stamps, reads: asOfReads }).services[0]?.reason).toBe('cutoff_invalid');
    expect(jointWatermarkAsOf({ cutOff: '2026-10-20', stamps, reads: asOfReads }).services[0]?.reason).toBe('cutoff_invalid');
  });
  it('a read taken before the cut-off, or as of a finer instant, is not a read as of it', () => {
    const early = jointWatermarkAsOf({
      cutOff,
      stamps,
      reads: [{ ...asOfReads[0]!, readAt: '2026-10-20T11:50:00.000Z' }, ...asOfReads.slice(1)],
    });
    expect(early.services[0]?.reason).toBe('read_before_cutoff');
    const micro = jointWatermarkAsOf({ cutOff, stamps, reads: [asOf(reads[0]!, '2026-10-20T12:00:00.000900Z'), ...asOfReads.slice(1)] });
    expect(micro.services[0]?.reason).toBe('read_not_as_of');
  });
  it('takes the newest read per service, as it takes the newest stamp', () => {
    const r = jointWatermarkAsOf({ cutOff, stamps, reads: [asOf(reads[0]!, null), ...asOfReads] });
    expect(r.agree).toBe(true);
  });
  it('the request carries one instant with an offset and nothing else', () => {
    expect(restoreWatermarkReadInputSchema.safeParse({ asOf: cutOff }).success).toBe(true);
    expect(restoreWatermarkReadInputSchema.safeParse({ asOf: '2026-10-20 12:00' }).success).toBe(false);
    expect(restoreWatermarkReadInputSchema.safeParse({ asOf: cutOff, live: true }).success).toBe(false);
    expect(restoreWatermarkReadSchema.safeParse({ ...reads[0], asOf: cutOff }).success).toBe(true);
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
