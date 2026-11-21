import { describe, expect, it } from 'vitest';
import { approvalState } from './venue-routes-logic';

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
