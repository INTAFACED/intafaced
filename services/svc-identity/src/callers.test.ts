import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { mergeRouters, procedureCallers, type CallerRule, type Context } from '@intafaced/contracts';

/**
 * Who may call each svc-identity procedure, listed from the routers `index.ts` merges into the service: the list of
 * routers is read from `index.ts` itself, so a router added there is listed here without anyone remembering to.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(HERE, 'index.ts'), 'utf8');

/** The router factories `index.ts` passes to `mergeRouters(...)`, in order. */
function mergedFactories(src: string): string[] {
  const start = src.indexOf('export const appRouter = mergeRouters(');
  if (start < 0) throw new Error('index.ts no longer builds `appRouter = mergeRouters(`; teach this test the new shape');
  const names: string[] = [];
  let depth = 0;
  let token = '';
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '(') {
      if (depth === 1) {
        const name = token.trim();
        if (!/^create\w+$/.test(name)) throw new Error(`mergeRouters takes \`${name}(\`, not a router factory; teach this test`);
        names.push(name);
      }
      depth++;
      token = '';
    } else if (ch === ')') {
      depth--;
      token = '';
      if (depth === 0) break;
    } else if (depth === 1) {
      token = ch === ',' ? '' : token + ch;
    }
  }
  return names;
}

/** Where `index.ts` imports each name from. */
function importSources(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) out.set(name, m[2]!);
    }
  }
  return out;
}

/** Stands in for every dependency: a router is built before any handler runs, and no handler runs here. */
const stub: unknown = new Proxy(function stub() {}, {
  get: (_t, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : stub),
  apply: () => stub,
});
/** The few factories that read a plain value while they build. */
const ARGS: Record<string, unknown[]> = { createRequestSigningPolicyRouter: [null] };

async function identityRouter() {
  const sources = importSources(INDEX);
  const routers = [];
  for (const name of mergedFactories(INDEX)) {
    const from = sources.get(name);
    if (!from) throw new Error(`index.ts merges ${name} but imports it from nowhere this test can read`);
    const factory = (await import(join(HERE, from.replace(/\.js$/, '.ts'))))[name] as (...args: unknown[]) => unknown;
    routers.push(factory(...(ARGS[name] ?? [stub, stub, stub, stub, stub, stub])));
  }
  return mergeRouters(...(routers as Parameters<typeof mergeRouters>));
}

/**
 * Procedures still built on `protectedProcedure`, which checks only that some principal is present and leaves who may
 * call to each handler. This list only shrinks: each moves to `personProcedure`, `operatorProcedure` or
 * `scopedProcedure`, and then `protectedProcedure` stops being exported. Never add to it.
 */
const NOT_YET_NAMED = [
  'account.compromised.markReviewed',
  'account.compromised.mine',
  'account.compromised.reportStolenFunds',
  'account.compromised.start',
  'account.email.begin',
  'account.email.confirm',
  'account.phone.begin',
  'account.phone.confirm',
  'account.phone.remove',
  'account.safety.clearExtraControls',
  'account.safety.read',
  'account.safety.setExtraControls',
  'account.safety.setLocationConsent',
  'accountClosure.cancel',
  'accountClosure.check',
  'accountClosure.request',
  'accountClosure.status',
  'accountControls.archive',
  'accountControls.archiveHistory',
  'accountControls.archiveProposals',
  'accountControls.archiveState',
  'accountControls.change',
  'accountControls.changeOperatorEntitlement',
  'accountControls.closure',
  'accountControls.closureHistory',
  'accountControls.closureState',
  'accountControls.details',
  'accountControls.detailsDecide',
  'accountControls.detailsEdit',
  'accountControls.detailsHistory',
  'accountControls.detailsReviews',
  'accountControls.getState',
  'accountControls.history',
  'accountControls.limits',
  'accountControls.limitsClear',
  'accountControls.limitsHistory',
  'accountControls.limitsSet',
  'accountControls.operatorStatus',
  'accountControls.tierHistory',
  'accountControls.tierMove',
  'accountControls.tiers',
  'accountControls.tierState',
  'actionApproval.approve',
  'actionApproval.createSamePerson',
  'actionApproval.get',
  'actionApproval.list',
  'actionApproval.policies',
  'actionApproval.propose',
  'actionApproval.reject',
  'actionApproval.revoke',
  'approvalPolicy.rows',
  'approvalPolicy.set',
  'auth.changePassword',
  'auth.confirmEmailCode',
  'auth.requestEmailConfirmation',
  'auth.selfFreeze',
  'auth.selfFreezeStatus',
  'auth.stepUp',
  'auth.stepUpOptions',
  'auth.stepUpPay',
  'auth.subAccountSession',
  'authKeys.removeOld',
  'authKeys.rotate',
  'authKeys.state',
  'compliance.freezeIdentity',
  'compliance.unfreezeIdentity',
  'disableUser',
  'handle.change',
  'handle.get',
  'handle.setDiscoverable',
  'me',
  'profile.antiPhishing.get',
  'profile.antiPhishing.set',
  'profile.get',
  'profile.update',
  'qr.mine',
  'qr.resolve',
  'receiveContacts.add',
  'receiveContacts.list',
  'receiveContacts.remove',
  'receiveContacts.verify',
  'staff.invite',
  'staff.list',
  'staffTestStatus',
  'stepUp.begin',
  'stepUp.complete',
  'subAccounts.assets',
  'subAccounts.delete',
  'subAccounts.deleteCheck',
  'subAccounts.getFeatures',
  'subAccounts.setFeatures',
  'supportRecovery.cancel',
  'supportRecovery.case',
  'supportRecovery.open',
  'supportRecovery.sendLink',
  'totp.confirm',
  'totp.enrol',
  'users.setPayeeSearchConsent',
  'waitlist.mine',
  'webauthn.list',
  'webauthn.registerOptions',
  'webauthn.registerVerify',
  'webauthn.remove',
  'workItems.list',
];

const USER = '11111111-1111-4111-8111-111111111111';
const session = {
  sub: USER,
  userId: USER,
  sid: '22222222-2222-4222-8222-222222222222',
  scopes: [...SESSION_SCOPES],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(Date.now() + 60_000),
} as Principal;
const key = { ...session, kid: 'key-1' } as Principal;
const subAccount = { ...session, sub_account: '33333333-3333-4333-8333-333333333333' } as Principal;

function ctx(principal: Principal): Context {
  return { principal, service: null, region: 'GB', requestId: 'callers' };
}

async function outcome(api: unknown, principal: Principal, path: string): Promise<string> {
  const caller = (api as { createCaller(c: Context): unknown }).createCaller(ctx(principal));
  const fn = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], caller) as (i?: unknown) => Promise<unknown>;
  try {
    await fn(undefined);
    return 'ran';
  } catch (err) {
    return (err as { code?: string }).code ?? 'threw';
  }
}

describe('svc-identity callers', async () => {
  const api = await identityRouter();
  const rows = procedureCallers(api);
  const named = (rule: CallerRule) => rows.filter((r) => r.caller === rule).map((r) => r.path);

  it('lists every router index.ts merges', () => {
    expect(mergedFactories(INDEX).length).toBeGreaterThan(50);
    expect(rows.length).toBeGreaterThan(300);
  });

  it('every procedure names who may call it, except the shrinking list still on protectedProcedure', () => {
    expect(rows.filter((r) => r.caller === undefined).map((r) => r.path)).toEqual(NOT_YET_NAMED);
  });

  it('auth.logoutAll is for the signed-in person only', () => {
    expect(named('person')).toContain('auth.logoutAll');
  });

  it.each(named('person'))('%s refuses an API key and a sub-account token before it runs', async (path) => {
    expect(await outcome(api, key, path)).toBe('FORBIDDEN');
    expect(await outcome(api, subAccount, path)).toBe('FORBIDDEN');
  });

  it.each(named('operator'))('%s refuses an ordinary session and an API key', async (path) => {
    expect(await outcome(api, session, path)).toBe('FORBIDDEN');
    expect(await outcome(api, key, path)).toBe('FORBIDDEN');
  });
});

describe('auth.logoutAll with an API key', () => {
  it('is refused and revokes no session', async () => {
    const { createIdentityRouter } = await import('./router.js');
    const logoutAll = vi.fn(async () => 3);
    const api = createIdentityRouter({ logoutAll } as never, stub as never, {});
    expect(await outcome(api, key, 'auth.logoutAll')).toBe('FORBIDDEN');
    expect(logoutAll).not.toHaveBeenCalled();
    expect(await outcome(api, session, 'auth.logoutAll')).toBe('ran');
    expect(logoutAll).toHaveBeenCalledWith(USER);
  });
});
