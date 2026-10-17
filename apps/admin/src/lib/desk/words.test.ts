import { describe, expect, it } from 'vitest';
import { actorRef, codeWords } from './words';

describe('desk words', () => {
  it('turns the p2p moderation codes into sentences', () => {
    expect(codeWords('p2p.moderation_unprobed')).toBe('Moderators are listed, but nobody has checked they are watching the queue');
    expect(codeWords('p2p.moderation_unreachable')).toBe('No moderators are set up');
  });
  it('words any other service code by its last part, and leaves ordinary values alone', () => {
    expect(codeWords('pay.halt_store_unavailable')).toBe('Halt store unavailable');
    expect(codeWords('USD')).toBe('USD');
    expect(codeWords('example.com')).toBe('example.com');
    expect(codeWords('Open')).toBe('Open');
  });
  it('shows an identity id as a short labelled reference, never the whole UUID', () => {
    const ref = actorRef('3faadae7-1111-4111-8111-1234567890ab');
    expect(ref).toBe('Account, id ends …90ab');
    expect(ref).not.toContain('3faadae7');
    expect(actorRef('reconciliation')).toBe('reconciliation');
    expect(actorRef(null)).toBe('—');
  });
});
