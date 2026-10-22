import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const ts = () => new Date().toISOString();
const ok = { version: 3, change: 'silence', subjectId: 'sil-1', actor: crypto.randomUUID(), changedAt: ts() };

describe('OPS-alerts-02 alert policy event', () => {
  it('declares intafaced.core-ops.alert_policy.updated', () => {
    expect(EVENT_CATALOG.coreOpsAlertPolicyUpdated.subject).toBe('intafaced.core-ops.alert_policy.updated');
    expect(EVENT_CATALOG.coreOpsAlertPolicyUpdated.schema.safeParse(ok).success).toBe(true);
  });

  it('refuses version 0, an unknown change, an empty actor and a bad time', () => {
    const s = EVENT_CATALOG.coreOpsAlertPolicyUpdated.schema;
    expect(s.safeParse({ ...ok, version: 0 }).success).toBe(false);
    expect(s.safeParse({ ...ok, change: 'deleted' }).success).toBe(false);
    expect(s.safeParse({ ...ok, actor: '' }).success).toBe(false);
    expect(s.safeParse({ ...ok, changedAt: 'now' }).success).toBe(false);
  });

  it('carries no contact secrets', () => {
    const parsed = EVENT_CATALOG.coreOpsAlertPolicyUpdated.schema.parse({ ...ok, webhookSecret: 'shh' });
    expect(parsed).not.toHaveProperty('webhookSecret');
  });
});
