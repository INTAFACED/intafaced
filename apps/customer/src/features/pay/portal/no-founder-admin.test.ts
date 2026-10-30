import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * G9: the merchant portal never reaches an operator procedure. `founderAdmin.*` is the founders-only namespace
 * in svc-pay; a merchant page that named it would be one typo from calling an operator door with a merchant
 * session. The name is assembled here so this file does not match itself.
 */
const banned = new RegExp(['founder', 'Admin'].join(''), 'i');
const root = fileURLToPath(new URL('../../..', import.meta.url)); // apps/customer/src

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
    return /\.(ts|tsx|css|mjs|html)$/.test(name) && !/\.(test|pw)\.|\.fixtures\./.test(name) ? [full] : [];
  });
}

describe('no founder or operator door in the merchant portal (G9)', () => {
  it('names no founder-only procedure anywhere in the pay feature', () => {
    const offenders = sources(join(root, 'features', 'pay')).filter((file) => banned.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('calls only merchant-scoped namespaces from the portal', () => {
    // The client is the core plus one file per package (api.ts, api-core.ts, money/api.ts, payments/api.ts, settings/api.ts,
    // catalog/api.ts).
    const portal = sources(join(root, 'features', 'pay', 'portal')).filter((file) => /[\\/](api|api-core)\.ts$/.test(file));
    expect(portal.length).toBe(6);
    const text = portal.map((file) => readFileSync(file, 'utf8')).join('\n');
    const procedures = [
      ...text.matchAll(
        /'((?:(?:merchant|merchantOps|merchantCatalog|merchantStores|merchantMetrics|merchantControl|merchantAnalytics|submerchant|submerchantPermission|payHalts|payment|settlement|conversion)\.[A-Za-z.]+|railHealth))'/g,
      ),
    ].map((m) => m[1]!);
    expect(procedures.length).toBeGreaterThan(20);
    for (const name of procedures)
      expect(name, name).toMatch(
        new RegExp(
          [
            '^(merchantOps\\.|merchantCatalog\\.|merchantStores\\.|merchantMetrics\\.|merchantAnalytics\\.|submerchant(Permission)?\\.|merchant\\.(me|myAccess|create|submitKyb|setPayoutDestination|listLinks|checkoutSettings\\.get|payoutDestinations\\.(list|setDefault|remove)|statement\\.list|businessProfile\\.[A-Za-z]+|onboarding\\.progress|terms\\.accept)$|railHealth$',
            // W3b: the merchant's own reads, and the three maker-checker calls. The operator side of these namespaces is not named here.
            'payment\\.(list|get|history|refunds\\.(list|get))$',
            // M-adv-payments-core-01: the caller's own saved views and one clear payer detail, on the caller's business.
            'payment\\.(views\\.(list|create|delete)|unmask)$',
            'settlement\\.(list|get|lines|clearing|lifecycle|payout)$',
            'payHalts\\.status$',
            // Merchant-scoped on main (svc-pay checks a `pay:*` scope, never a founder role): history, tiers, limits, payout request.
            'merchantControl\\.(get|reserve|topUp\\.options|usage|pricing\\.(preview|history)|tiers\\.list|limits\\.(open|requestIncrease|withdraw)|approvals\\.(list|request|decide|cancel))$',
            'conversion\\.(quote|execute|get|list)$)',
          ].join('|'),
        ),
      );
    expect(text).not.toMatch(/admin:|operator|killswitch/i);
  });
  it('reaches only allowlisted procedures from every api and client file under the portal', () => {
    // Every file that talks to the service: *api*.ts and client.ts, wherever they sit under portal/. Named files below
    // must be among them, so the scan cannot quietly shrink to fewer files.
    const portalRoot = join(root, 'features', 'pay', 'portal');
    const files = sources(portalRoot).filter((file) => /[\\/](?:[^\\/]*api[^\\/]*|[^\\/]*client)\.ts$/.test(file));
    const rel = files.map((file) => file.slice(portalRoot.length + 1).replace(/\\/g, '/'));
    for (const must of [
      'api.ts',
      'api-core.ts',
      'api-tools.ts',
      'money/api.ts',
      'payments/api.ts',
      'settings/api.ts',
      'catalog/api.ts',
      'settings/account/account-api.ts',
      'settings/analytics/client.ts',
      'settings/reports/client.ts',
      'settings/developers/client.ts',
    ])
      expect(rel, must).toContain(must);
    // Namespaces (the part before the first dot) that hold only merchant-facing procedures, so the whole namespace may be
    // named. `apiKeys` and the signing and address calls are the identity service's key management for the merchant's own
    // keys; `mandate` and `subscription` are the merchant's own reads.
    const wholeNamespaces = new Set([
      'merchantOps',
      // The business's own product catalogue (svc-pay catalog/router.ts): every procedure resolves the caller's business.
      'merchantCatalog',
      // The business's own stores (svc-pay catalog/router.ts): every procedure resolves the caller's business.
      'merchantStores',
      // The look of the business's own hosted checkout (svc-pay checkout-branding/router.ts): resolves the caller's business.
      'merchantCheckout',
      // The payment methods of the business's own hosted checkout (svc-pay checkout-methods/router.ts): resolves the caller's business.
      'merchantCheckoutMethods',
      'merchantMetrics',
      'merchantAnalytics',
      'submerchant',
      'submerchantPermission',
      'subscription',
      'mandate',
      'apiKeys',
    ]);
    // Namespaces shared with the operator side: only the listed procedures are the merchant's own. A new name in any of
    // these (a refund create, a settlement release, a halt toggle) fails here until someone decides it is merchant-scoped.
    const mixedNamespaces: Record<string, Set<string>> = {
      merchant: new Set([
        'merchant.me',
        'merchant.myAccess',
        'merchant.create',
        'merchant.submitKyb',
        'merchant.setPayoutDestination',
        'merchant.listLinks',
        'merchant.checkoutSettings.get',
        'merchant.payoutDestinations.list',
        'merchant.payoutDestinations.setDefault',
        'merchant.payoutDestinations.remove',
        'merchant.statement.list',
        'merchant.onboarding.progress',
        'merchant.businessProfile.get',
        'merchant.businessProfile.history',
        'merchant.businessProfile.submit',
        'merchant.businessProfile.confirm',
        'merchant.businessProfile.setSecondApproval',
        'merchant.terms.accept',
        'merchant.category.get',
        'merchant.category.choose',
      ]),
      merchantControl: new Set([
        'merchantControl.get',
        'merchantControl.reserve',
        'merchantControl.topUp.options',
        'merchantControl.usage',
        'merchantControl.pricing.preview',
        'merchantControl.pricing.history',
        'merchantControl.tiers.list',
        'merchantControl.limits.open',
        'merchantControl.limits.requestIncrease',
        'merchantControl.limits.withdraw',
        'merchantControl.approvals.list',
        'merchantControl.approvals.request',
        'merchantControl.approvals.decide',
        'merchantControl.approvals.cancel',
      ]),
      payment: new Set([
        'payment.list',
        'payment.get',
        'payment.history',
        'payment.refunds.list',
        'payment.refunds.get',
        // Saved views and one clear payer detail, scoped to the caller's own business (M-adv-payments-core-01).
        'payment.views.list',
        'payment.views.create',
        'payment.views.delete',
        'payment.unmask',
      ]),
      settlement: new Set([
        'settlement.list',
        'settlement.get',
        'settlement.lines',
        'settlement.clearing',
        'settlement.lifecycle',
        'settlement.payout',
      ]),
      payHalts: new Set(['payHalts.status']),
      conversion: new Set(['conversion.quote', 'conversion.execute', 'conversion.get', 'conversion.list']),
      // The business application is the merchant's own (`pay:onboard`); `kyb.decide` and `kyb.decisionBinding` are the operator's.
      kyb: new Set([
        'kyb.entityTypes.read',
        'kyb.application.current',
        'kyb.application.start',
        'kyb.application.changeType',
        'kyb.application.saveSection',
        'kyb.application.restart',
        'kyb.application.submit',
        'kyb.documents.checklist',
        'kyb.documents.upload',
        'kyb.requests.list',
        'kyb.requests.answer',
      ]),
    };
    // Procedures with no dot in their name, each allowed by name.
    const bare = new Set([
      'railHealth',
      'setApiKeyRequestSigning',
      'rotateSigningSecret',
      'bindApiKeyIpAllowlist',
      'unbindApiKeyIpAllowlist',
    ]);
    // Dotted strings that are not procedures (a local refusal code the page writes itself).
    const notProcedures = new Set(['portal.local']);
    const offenders: string[] = [];
    let seen = 0;
    for (const [i, file] of files.entries()) {
      const text = readFileSync(file, 'utf8');
      const named = new Set<string>();
      // Every 'x.y' string, and the first argument of every call that sends a procedure (not `api.query('pay', …)`, whose first argument is the service).
      for (const m of text.matchAll(/['"`]([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)['"`]/g)) named.add(m[1]!);
      for (const m of text.matchAll(/(?<![.\w])(?:query|mutate|identityQuery|identityMutate)\(\s*['"`]([A-Za-z][A-Za-z0-9.]*)['"`]/g))
        named.add(m[1]!);
      for (const name of named) {
        if (notProcedures.has(name)) continue;
        seen += 1;
        const space = name.split('.')[0]!;
        const ok = !name.includes('.') ? bare.has(name) : wholeNamespaces.has(space) || (mixedNamespaces[space]?.has(name) ?? false);
        if (!ok) offenders.push(`${rel[i]}: ${name}`);
      }
    }
    expect(seen).toBeGreaterThan(80);
    expect(offenders).toEqual([]);
  });
  it('keeps the whole customer app free of the founder namespace', () => {
    const offenders = sources(root).filter((file) => banned.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
