import { describe, expect, it } from 'vitest';
import { NOTIFY_INBOX_POLICY } from '@intafaced/contracts/notify-inbox-policy';
import { createNotifyRouter } from './router.js';
import type { NotifyService } from './notify-service.js';

type Mounted = { _def: { inputs: unknown[]; output?: unknown } };
/** tRPC keeps a router's mounted parsers in `_def.procedures`, keyed by dotted path; its public type does not name them. */
function isProcedureMap(value: unknown): value is Record<string, Mounted> {
  return typeof value === 'object' && value !== null;
}
function mountedProcedures(router: object): Record<string, Mounted> {
  const def: unknown = Reflect.get(router, '_def');
  const procedures: unknown = typeof def === 'object' && def !== null ? Reflect.get(def, 'procedures') : undefined;
  if (!isProcedureMap(procedures)) throw new Error('the router has no _def.procedures');
  return procedures;
}

/** Each call svc-notify serves from a written record is mounted with that record's own schemas, never a copy. */
describe('svc-notify serves its recorded calls from their records', () => {
  const router = createNotifyRouter({} as NotifyService, undefined, undefined, undefined, {
    pageSize: 20,
    unreadCap: 99,
    retentionDays: null,
  });
  const procedures = mountedProcedures(router);

  it.each([NOTIFY_INBOX_POLICY])('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-notify');
    const mounted = procedures[record.path];
    expect(mounted, `${record.path} is not on svc-notify's router`).toBeDefined();
    expect(mounted!._def.inputs).toContain(record.input);
    expect(mounted!._def.output).toBe(record.output);
  });

  it('answers the owner values through the record, and blank ones as null with their codes', async () => {
    const set = await router.createCaller({} as never).notify.inboxPolicy();
    expect(NOTIFY_INBOX_POLICY.output.parse(set)).toMatchObject({ pageSize: 20, unreadCap: 99, pageSizeUnsetCode: null });
    const blank = await createNotifyRouter({} as NotifyService)
      .createCaller({} as never)
      .notify.inboxPolicy();
    expect(blank).toMatchObject({
      pageSize: null,
      pageSizeUnsetCode: 'notify.list_limit_unset',
      unreadCap: null,
      unreadCapUnsetCode: 'notify.unread_cap_unset',
    });
  });
});
