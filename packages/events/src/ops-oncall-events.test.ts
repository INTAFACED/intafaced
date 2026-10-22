import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const ts = () => new Date().toISOString();

describe('OPS-oncall-01 alert group events', () => {
  it('declares the three subjects', () => {
    expect(EVENT_CATALOG.coreOpsAlertGroupOpened.subject).toBe('intafaced.core-ops.alert_group.opened');
    expect(EVENT_CATALOG.coreOpsAlertGroupUpdated.subject).toBe('intafaced.core-ops.alert_group.updated');
    expect(EVENT_CATALOG.coreOpsAlertGroupResolved.subject).toBe('intafaced.core-ops.alert_group.resolved');
  });

  it('refuses an empty group id, an unknown action and sequence 0', () => {
    expect(EVENT_CATALOG.coreOpsAlertGroupOpened.schema.safeParse({ groupId: '', chainId: null, labels: [], openedAt: ts() }).success).toBe(
      false,
    );
    const upd = { groupId: 'g', action: 'acknowledged', sequence: 1, actor: 'op', changedAt: ts() };
    expect(EVENT_CATALOG.coreOpsAlertGroupUpdated.schema.safeParse(upd).success).toBe(true);
    expect(EVENT_CATALOG.coreOpsAlertGroupUpdated.schema.safeParse({ ...upd, action: 'deleted' }).success).toBe(false);
    expect(EVENT_CATALOG.coreOpsAlertGroupUpdated.schema.safeParse({ ...upd, sequence: 0 }).success).toBe(false);
    expect(
      EVENT_CATALOG.coreOpsAlertGroupResolved.schema.safeParse({ groupId: 'g', sequence: 1, actor: '', resolvedAt: ts() }).success,
    ).toBe(false);
  });
});
