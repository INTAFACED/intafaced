import { describe, expect, it } from 'vitest';
import { approvalAtConfirm, approvalState } from './venue-routes-logic';

describe('approvalState', () => {
  it('needs no approval for an order that carries no builder fee', () => {
    expect(approvalState(false, '0.5', { approved: null, failed: false })).toBe('not_needed');
  });
  it('is still reading while the venue has not answered, so Confirm never asks for an approval already signed', () => {
    expect(approvalState(true, '0.5', { approved: null, failed: false })).toBe('reading');
  });
  it('is approved when the venue holds at least our published fee', () => {
    expect(approvalState(true, '0.5', { approved: '0.5', failed: false })).toBe('approved');
    expect(approvalState(true, '0.5', { approved: '1', failed: false })).toBe('approved');
  });
  it('needs the approval when the venue holds less, our fee is not published, or the read failed', () => {
    expect(approvalState(true, '0.5', { approved: '0', failed: false })).toBe('needed');
    expect(approvalState(true, '0.5', { approved: '0.4', failed: false })).toBe('needed');
    expect(approvalState(true, null, { approved: '0.5', failed: false })).toBe('needed');
    expect(approvalState(true, '0.5', { approved: null, failed: true })).toBe('needed');
  });
});

describe('approvalAtConfirm', () => {
  const held = (value: string) => async () => ({ ok: true as const, data: { value } });
  const lost = async () => ({ ok: false as const });
  const never = async () => {
    throw new Error('read again');
  };
  it('orders at once when the poll already shows the approval held, or the order carries no fee', async () => {
    await expect(approvalAtConfirm(true, '0.5', 'approved', never)).resolves.toBe('approved');
    await expect(approvalAtConfirm(false, '0.5', 'not_needed', never)).resolves.toBe('not_needed');
  });
  it('reads the venue again after a failed poll, and never asks for an approval the venue already holds', async () => {
    await expect(approvalAtConfirm(true, '0.5', 'needed', held('0.5'))).resolves.toBe('approved');
    await expect(approvalAtConfirm(true, '0.5', 'reading', held('1'))).resolves.toBe('approved');
  });
  it('still asks for the approval when the fresh read shows less than our fee, or fails too', async () => {
    await expect(approvalAtConfirm(true, '0.5', 'needed', held('0.4'))).resolves.toBe('needed');
    await expect(approvalAtConfirm(true, '0.5', 'needed', lost)).resolves.toBe('needed');
    await expect(approvalAtConfirm(true, null, 'needed', held('0.5'))).resolves.toBe('needed');
  });
});
