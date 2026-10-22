import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { randomUUID } from 'node:crypto';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { createMemoryAlertRuleStore } from './rule-store.js';
import { AlertRules } from './rules.js';
import { createMemoryAlertState } from './state-store.js';
import { createMemoryAlertDesk } from './desk-store.js';
import { heartbeatJudgement } from './overview.js';
import { instanceOf } from './evaluate.js';
import {
  OPS_ALERT_ACTOR_UNSET,
  OPS_ALERT_HEARTBEAT_ABSENT,
  OPS_ALERT_HEARTBEAT_WINDOW_UNSET,
  OPS_ALERT_LIST_LIMIT_UNSET,
  OPS_ALERT_QUALITY_ENFORCED,
  OPS_ALERT_QUALITY_NOTHING_REQUIRED,
  OPS_ALERT_QUALITY_POLICY_UNSET,
  OPS_ALERT_STORAGE_UNCONFIGURED,
  OPS_ALERT_TEMPLATE_BODY_UNSET,
} from '../codes.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

const draft = {
  name: 'Ledger postings stalled',
  folder: 'ledger',
  group: 'every-minute',
  signal: 'ledger.postings.count',
  condition: { operator: 'lt' as const, threshold: '1' },
  intervalSeconds: 60,
  pendingSeconds: 120,
  labels: { owner: 'founder' },
  annotations: { summary: 'Postings stopped', dashboardUid: 'desk-1', panelId: 'panel-9' },
  reason: 'first rule',
};

describe('heartbeat judgement', () => {
  const beat = { actor: USER, reason: 'tick', recordedAt: '2026-10-20T00:00:00.000Z' };

  it('does not call a beat overdue when the owner window is blank', () => {
    const judged = heartbeatJudgement(beat, null, '2026-10-20T01:00:00.000Z');
    expect(judged.overdue).toBeNull();
    expect(judged.code).toBe(OPS_ALERT_HEARTBEAT_WINDOW_UNSET);
    expect(JSON.stringify(judged)).not.toContain('"overdue":false');
  });

  it('does not invent lateness when no beat was recorded', () => {
    const judged = heartbeatJudgement(null, 60, '2026-10-20T00:01:00.000Z');
    expect(judged.last).toBeNull();
    expect(judged.overdue).toBeNull();
    expect(judged.code).toBe(OPS_ALERT_HEARTBEAT_ABSENT);
  });

  it('compares a recorded beat with the owner window', () => {
    expect(heartbeatJudgement(beat, 60, '2026-10-20T00:00:30.000Z').overdue).toBe(false);
    expect(heartbeatJudgement(beat, 60, '2026-10-20T00:01:01.000Z').overdue).toBe(true);
  });
});

describe('alert desk (OPS-alerts-03)', () => {
  const now = () => '2026-10-20T00:00:00.000Z';

  async function open(opts: { window?: number | null; withState?: boolean } = {}) {
    const desk = createMemoryAlertDesk();
    const rules = new AlertRules(createMemoryAlertRuleStore(), now, randomUUID, desk);
    const state = opts.withState === false ? undefined : createMemoryAlertState();
    const caller = createOpsRouter(new OpsService(), undefined, {
      now,
      alertRules: rules,
      alertDesk: desk,
      ...(state ? { alertState: state } : {}),
      alertHeartbeatMaxAgeSeconds: opts.window === undefined ? null : opts.window,
    }).createCaller(await signed());
    return { caller, state, rules };
  }

  it('refuses the overview, a heartbeat and a template when nothing is stored', async () => {
    const caller = createOpsRouter(new OpsService(), undefined, { now }).createCaller(await signed());
    await expect(caller.alerts.activity({ limit: 10 })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
    await expect(caller.alerts.heartbeat({ reason: 'because', idempotencyKey: 'beat-key-01' })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
    await expect(caller.alertTemplates.list({ limit: 10 })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_STORAGE_UNCONFIGURED),
    });
    const listed = await caller.alerts.list();
    expect(listed.alerts).toBeNull();
  });

  it('lists firing and pending alerts and leaves a normal rule out, with no invented open count', async () => {
    const { caller, state } = await open({ withState: true });
    const saved = await caller.alertRules.create({ ...draft, idempotencyKey: 'alert-key-0001' });
    const quiet = await caller.alertRules.create({
      ...draft,
      name: 'Quiet',
      labels: { owner: 'quiet' },
      idempotencyKey: 'alert-key-0002',
    });
    const firing = {
      state: 'firing' as const,
      health: 'ok' as const,
      epoch: 1,
      pendingSince: '2026-10-20T00:00:00.000Z',
      firingSince: '2026-10-20T00:00:00.000Z',
      lastEvaluatedAt: '2026-10-20T00:00:00.000Z',
      lastValue: '9',
      lastCode: null,
      kept: false,
    };
    await state!.evaluate(saved.id, instanceOf(saved.id), () => ({ next: firing, changed: true, transitions: [] }));
    await state!.evaluate(quiet.id, instanceOf(quiet.id), () => ({
      next: { ...firing, state: 'normal', firingSince: null, lastValue: null },
      changed: true,
      transitions: [],
    }));
    const page = await caller.alerts.activity({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      ruleId: saved.id,
      ruleName: saved.name,
      state: 'firing',
      lastValue: '9',
      panel: { dashboardUid: 'desk-1', panelId: 'panel-9' },
    });
    expect(page.truncated).toBe(false);
    expect(JSON.stringify(page)).not.toContain('"open":0');
    await expect(caller.alerts.activity({})).rejects.toMatchObject({ message: expect.stringContaining(OPS_ALERT_LIST_LIMIT_UNSET) });
  });

  it('records a heartbeat with the actor and reason, replays it, and will not judge a blank window', async () => {
    const { caller } = await open();
    const body = { reason: 'evaluator is up', idempotencyKey: 'beat-key-01' };
    const first = await caller.alerts.heartbeat(body);
    expect(first).toEqual({ actor: USER, reason: body.reason, recordedAt: now() });
    expect(await caller.alerts.heartbeat(body)).toEqual(first);
    await expect(caller.alerts.heartbeat({ ...body, reason: 'other' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const status = await caller.alerts.heartbeatStatus();
    expect(status).toMatchObject({ last: first, maxAgeSeconds: null, overdue: null, code: OPS_ALERT_HEARTBEAT_WINDOW_UNSET });
    const reader = createOpsRouter(new OpsService(), undefined, { now }).createCaller(
      await signed(principal({ scopes: ['admin:read'], mfa: false })),
    );
    await expect(reader.alerts.heartbeat(body)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('names an absent beat when the window is set and none was recorded', async () => {
    const { caller } = await open({ window: 120 });
    const status = await caller.alerts.heartbeatStatus();
    expect(status).toMatchObject({ last: null, maxAgeSeconds: 120, overdue: null, code: OPS_ALERT_HEARTBEAT_ABSENT });
  });

  it('refuses a blank actor and a blank template body before storing either', async () => {
    const desk = createMemoryAlertDesk();
    await expect(
      desk.recordHeartbeat({ key: 'beat-key-02', fingerprint: 'a'.repeat(64), actor: '   ', reason: 'because', at: now() }),
    ).rejects.toMatchObject({ code: OPS_ALERT_ACTOR_UNSET });
    expect(await desk.latestHeartbeat()).toBeNull();
    const writer = createOpsRouter(new OpsService(), undefined, { now, alertDesk: desk, alertHeartbeatMaxAgeSeconds: null }).createCaller(
      await signed(),
    );
    await expect(
      writer.alertTemplates.save({ name: 'page', body: '   ', reason: 'because', idempotencyKey: 'tpl-key-0001' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_TEMPLATE_BODY_UNSET),
    });
    expect(await writer.alertTemplates.list({ limit: 10 })).toEqual({ templates: [] });
  });

  it('saves a template with its audit and does not invent a default', async () => {
    const { caller } = await open();
    const saved = await caller.alertTemplates.save({
      name: 'page',
      body: 'Look at the ledger desk',
      reason: 'first wording',
      idempotencyKey: 'tpl-key-0001',
    });
    expect(saved).toMatchObject({ name: 'page', version: 1, actor: USER, reason: 'first wording' });
    expect(
      await caller.alertTemplates.save({
        name: 'page',
        body: 'Look at the ledger desk',
        reason: 'first wording',
        idempotencyKey: 'tpl-key-0001',
      }),
    ).toEqual(saved);
    const next = await caller.alertTemplates.save({
      name: 'page',
      body: 'Look at the panel',
      reason: 'clearer',
      expectedVersion: 1,
      idempotencyKey: 'tpl-key-0002',
    });
    expect(next.version).toBe(2);
    expect((await caller.alertTemplates.list({ limit: 10 })).templates).toEqual([next]);
  });

  it('keeps an unset quality policy null, and an empty policy is not a score', async () => {
    const { caller } = await open();
    expect(await caller.alertQuality.get()).toEqual({ policy: null, code: OPS_ALERT_QUALITY_POLICY_UNSET });
    expect(await caller.alertQuality.findings({ limit: 10 })).toMatchObject({
      findings: null,
      checked: null,
      code: OPS_ALERT_QUALITY_POLICY_UNSET,
    });
    const saved = await caller.alertQuality.set({ requirements: [], reason: 'check nothing yet', idempotencyKey: 'qual-key-01' });
    expect(saved.requirements).toEqual([]);
    expect(saved.actor).toBe(USER);
    expect(await caller.alertQuality.findings({ limit: 10 })).toMatchObject({
      findings: null,
      checked: null,
      code: OPS_ALERT_QUALITY_NOTHING_REQUIRED,
    });
  });

  it('blocks an enforced save and still lists a detect-only miss', async () => {
    const { caller } = await open();
    await caller.alertQuality.set({
      requirements: [{ kind: 'annotation', key: 'summary', mode: 'enforce' }],
      reason: 'need a summary',
      idempotencyKey: 'qual-key-02',
    });
    const { summary: _summary, ...annotations } = draft.annotations;
    await expect(caller.alertRules.create({ ...draft, annotations, idempotencyKey: 'alert-key-0003' })).rejects.toMatchObject({
      message: expect.stringContaining(OPS_ALERT_QUALITY_ENFORCED),
    });
    expect((await caller.alertRules.list({ limit: 10 })).rules).toEqual([]);
    await caller.alertQuality.set({
      requirements: [{ kind: 'label', key: 'team', mode: 'detect' }],
      reason: 'team is a finding only',
      expectedVersion: 1,
      idempotencyKey: 'qual-key-03',
    });
    const saved = await caller.alertRules.create({ ...draft, idempotencyKey: 'alert-key-0004' });
    const findings = await caller.alertQuality.findings({ limit: 10 });
    expect(findings.checked).toBe(1);
    expect(findings.findings).toEqual([{ ruleId: saved.id, name: saved.name, missing: [{ kind: 'label', key: 'team', mode: 'detect' }] }]);
  });
});
