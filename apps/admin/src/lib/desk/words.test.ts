import { describe, expect, it } from 'vitest';
import { actorRef, codeWords } from './words';

describe('desk words', () => {
  it('turns the p2p moderation codes into sentences', () => {
    expect(codeWords('p2p.moderation_unprobed')).toBe(
      'Moderators are configured; the service cannot tell whether anyone is watching the queue',
    );
    expect(codeWords('p2p.moderation_unreachable')).toBe('No moderators are set up');
  });
  it('words the Personal Pay reason codes and transfer kinds', () => {
    expect(codeWords('served_by_p2p_ops')).toBe('Counted on the P2P desk; svc-bank gives no P2P figure');
    expect(codeWords('failures_not_recorded')).toBe('svc-bank does not record a refused one-off send, so it has no failure figure');
    expect(codeWords('standing_order')).toBe('Standing order');
    expect(codeWords('one_off')).toBe('One-off send');
    expect(codeWords('socket.psp-partners')).toBe('A payment-service partner is not connected');
    expect(codeWords('ledger.insufficient_funds')).toBe('Insufficient funds');
  });
  it('words any other service code by its last part, and leaves ordinary values alone', () => {
    expect(codeWords('pay.halt_store_unavailable')).toBe('Halt store unavailable');
    expect(codeWords('USD')).toBe('USD');
    expect(codeWords('example.com')).toBe('example.com');
    expect(codeWords('pay.intafaced.com')).toBe('pay.intafaced.com');
    expect(codeWords('support.example.com')).toBe('support.example.com');
    expect(codeWords('Open')).toBe('Open');
  });
  it('words the plain reason codes the new operator reads return, and never mistakes an object property for a code', () => {
    expect(codeWords('utilisation_not_recorded')).toBe('Not recorded by svc-bank');
    expect(codeWords('ledger_unavailable')).toBe('The ledger could not be read');
    expect(codeWords('handle_unresolved')).toBe('The directory could not name this person');
    expect(codeWords('no_heartbeat')).toBe('The service gives no heartbeat');
    expect(codeWords('constructor')).toBe('constructor');
    expect(codeWords('toString')).toBe('toString');
  });
  it('shows an identity id as a short labelled reference, never the whole UUID', () => {
    const ref = actorRef('3faadae7-1111-4111-8111-1234567890ab');
    expect(ref).toBe('Account, id ends …90ab');
    expect(ref).not.toContain('3faadae7');
    expect(actorRef('reconciliation')).toBe('reconciliation');
    expect(actorRef(null)).toBe('—');
  });
});
