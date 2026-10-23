import { describe, expect, it } from 'vitest';
import { codeInText, explainRefusal, isKnownCode } from './refusal-copy';

describe('typed refusals are explained in plain words', () => {
  it('a known code is a definite answer whatever the status', () => {
    for (const status of [400, 403, 409, 500, 503]) {
      const r = explainRefusal('action_approval.same_person', status);
      expect(r.changed).toBe('no');
      expect(r.title).toContain('different founder');
    }
  });
  it('the second-founder rules each have their own words', () => {
    expect(explainRefusal('action_approval.not_approved', 400).title).toContain('has not approved');
    expect(explainRefusal('action_approval.payload_mismatch', 412).body).toContain('Nothing was approved');
    expect(explainRefusal('action_approval.consumed', 412).title).toContain('already used');
    // A used approval may be the first run of this very request that went through: not a definite "nothing changed".
    expect(explainRefusal('action_approval.consumed', 412).changed).toBe('unknown');
    expect(explainRefusal('action_approval.expired', 412).title).toContain('expired');
    expect(explainRefusal('action_approval.founder_only', 403).title).toContain('two current founders');
  });
  it('a slow identity check is temporary, retrying, and changed nothing', () => {
    const r = explainRefusal('edge.authority_unavailable', 503);
    expect(r.title).toBe('Temporary, retrying');
    expect(r.changed).toBe('no');
    expect(r.body).toContain('not sent on');
    expect(r.next).toContain('Retry');
  });
  it('an unknown 5xx or a dropped connection on a write is "not known", never "failed"', () => {
    const r = explainRefusal(null, 503);
    expect(r.changed).toBe('unknown');
    expect(r.title).toBe('The outcome is not known');
    expect(explainRefusal('mystery.code', 200, true).changed).toBe('unknown');
  });
  it('an unknown 4xx is a refusal that changed nothing', () => {
    for (const status of [400, 401, 403, 404, 409, 412, 422]) {
      const r = explainRefusal('mystery.code', status);
      expect(r.changed).toBe('no');
      expect(r.code).toBe('mystery.code');
    }
  });
  it('never echoes a raw status number as the explanation', () => {
    for (const status of [400, 403, 404, 409, 500]) {
      const r = explainRefusal(null, status);
      expect(`${r.title} ${r.body} ${r.next}`).not.toMatch(/\b(400|403|404|409|500)\b/);
    }
  });
});

describe('typed codes are found inside the wrapped sentences the edge and ledger send', () => {
  it('reads the identity code out of the edge’s consume failure', () => {
    const text = 'identity refused consumeForEdge (412) {"error":{"message":"approval is APPROVED [action_approval.not_approved]"}}';
    expect(codeInText(text)).toBe('action_approval.not_approved');
  });
  it('skips unknown action_approval codes and finds a later known one', () => {
    expect(codeInText('action_approval.names_are_not_authority then action_approval.expired')).toBe('action_approval.expired');
    expect(codeInText('action_approval.names_are_not_authority')).toBeNull();
    expect(codeInText(null)).toBeNull();
    expect(codeInText('no code here')).toBeNull();
  });
  it('knows which codes it can explain', () => {
    expect(isKnownCode('action_approval.same_person')).toBe(true);
    expect(isKnownCode('pay.halt_target_unsupported')).toBe(true);
    expect(isKnownCode('toString')).toBe(false);
    expect(isKnownCode(null)).toBe(false);
  });
});
